package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"github.com/exam-platform/backend/middleware"
	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

// ── Timing helpers ────────────────────────────────────────────────────────────

// examDeadlines computes the three absolute timestamps that govern a timed exam.
// Returns zero values when the exam has never been started (StartedAt == nil).
func examDeadlines(e models.Exam) (bufferEnd, examEnd, graceEnd time.Time) {
	if e.StartedAt == nil {
		return
	}
	bufferEnd = e.StartedAt.Add(time.Duration(e.BufferDurationMins) * time.Minute)
	examEnd   = bufferEnd.Add(time.Duration(e.DurationMinutes) * time.Minute)
	graceEnd  = examEnd.Add(2 * time.Minute)
	return
}

// autoExpire deactivates an exam whose clock has passed ExamEnd.
// It writes is_active=false to the database and mutates *e in place so the
// caller always returns fresh state. A no-op when the exam has no StartedAt or
// has already been deactivated.
func (h *Handler) autoExpire(e *models.Exam) {
	if !e.IsActive || e.StartedAt == nil {
		return
	}
	_, examEnd, _ := examDeadlines(*e)
	if examEnd.IsZero() || time.Now().UTC().Before(examEnd) {
		return
	}
	// Past ExamEnd — mark inactive. Ignore DB errors; the exam will simply be
	// deactivated on the next request if this write fails transiently.
	h.db.Model(e).Update("is_active", false)
	e.IsActive = false
}

// publicExamResponse omits correct_answers from all nested questions.
type publicExamResponse struct {
	models.Exam
	QuestionSets []publicQuestionSet `json:"question_sets"`
}

type publicQuestionSet struct {
	models.QuestionSet
	Questions []publicQuestion `json:"questions"`
}

type publicQuestion struct {
	ID               uint                `json:"id"`
	QuestionSetID    uint                `json:"question_set_id"`
	Type             models.QuestionType `json:"type"`
	Content          string              `json:"content"`
	Options          interface{}         `json:"options"`
	RandomizeOptions bool                `json:"randomize_options"`
	Points           int                 `json:"points"`
	Language         string              `json:"language"`
}

// activeExamItem is returned by GetActiveExams.
// login_code is intentionally excluded so students can't read the PIN from the API.
type activeExamItem struct {
	ID                 uint       `json:"id"`
	Title              string     `json:"title"`
	Description        string     `json:"description"`
	DurationMinutes    int        `json:"duration_minutes"`
	TeacherName        string     `json:"teacher_name"`
	StartedAt          *time.Time `json:"started_at"`
	BufferDurationMins int        `json:"buffer_duration_minutes"`
}

// GetActiveExams returns all currently active exams — public, no auth required.
// Students use this to build the lobby list.
// GET /api/exams/active
func (h *Handler) GetActiveExams(c *fiber.Ctx) error {
	var exams []models.Exam
	h.db.Where("is_active = ?", true).
		Preload("Teacher").
		Order("created_at desc").
		Find(&exams)

	items := make([]activeExamItem, 0, len(exams))
	for _, e := range exams {
		items = append(items, activeExamItem{
			ID:                 e.ID,
			Title:              e.Title,
			Description:        e.Description,
			DurationMinutes:    e.DurationMinutes,
			TeacherName:        e.Teacher.Name,
			StartedAt:          e.StartedAt,
			BufferDurationMins: e.BufferDurationMins,
		})
	}
	return c.JSON(items)
}

// VerifyPin validates a student's access PIN for a specific exam.
// If correct, returns a short-lived opaque access token the client stores
// in sessionStorage so re-entry doesn't require re-typing the PIN.
// POST /api/exams/:id/verify-pin
func (h *Handler) VerifyPin(c *fiber.Ctx) error {
	id, _ := strconv.Atoi(c.Params("id"))
	var exam models.Exam
	if err := h.db.First(&exam, id).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}
	if !exam.IsActive {
		return fiber.NewError(fiber.StatusForbidden, "exam is not currently active")
	}
	if exam.LoginCode == "" {
		return fiber.NewError(fiber.StatusBadRequest, "this exam has no access PIN configured")
	}

	var body struct {
		LoginCode string `json:"login_code"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	// Case-insensitive comparison so "MATH7" and "math7" both work.
	// 403 Forbidden (not 401): the request was understood but the credential is wrong.
	// Using 401 would trigger browser/client auth-interceptor logic unnecessarily.
	if !strings.EqualFold(strings.TrimSpace(body.LoginCode), exam.LoginCode) {
		return fiber.NewError(fiber.StatusForbidden, "Incorrect PIN. Please check and try again.")
	}

	// Generate a 16-byte random opaque access token.
	// The client stores this in sessionStorage as proof of PIN verification.
	// No server-side storage needed — it is not re-validated on subsequent requests.
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to generate token")
	}
	token := hex.EncodeToString(raw)

	return c.JSON(fiber.Map{"access_token": token, "exam_id": exam.ID})
}

// ListExams returns all exams belonging to the authenticated teacher.
// GET /api/exams
func (h *Handler) ListExams(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	var exams []models.Exam
	h.db.Where("teacher_id = ?", teacherID).
		Preload("QuestionSets.Questions").
		Order("created_at desc").
		Find(&exams)

	// Lazily deactivate any exams whose clock has expired.
	for i := range exams {
		h.autoExpire(&exams[i])
	}

	return c.JSON(exams)
}

// CreateExam creates a new exam for the authenticated teacher.
// POST /api/exams
func (h *Handler) CreateExam(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	var exam models.Exam
	if err := c.BodyParser(&exam); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if exam.Title == "" {
		return fiber.NewError(fiber.StatusBadRequest, "title is required")
	}
	if exam.DurationMinutes <= 0 {
		return fiber.NewError(fiber.StatusBadRequest, "duration_minutes must be greater than 0")
	}
	if exam.MaxCodeRuns < 0 || exam.MaxCodeRuns > 3 {
		return fiber.NewError(fiber.StatusBadRequest, "max_code_runs must be between 0 and 3")
	}

	exam.TeacherID = teacherID
	if result := h.db.Create(&exam); result.Error != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to create exam")
	}

	return c.Status(fiber.StatusCreated).JSON(exam)
}

// GetExam returns a single exam (teacher-authenticated, with correct answers).
// GET /api/exams/:id
func (h *Handler) GetExam(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id, _ := strconv.Atoi(c.Params("id"))
	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", id, teacherID).
		Preload("QuestionSets.Questions").
		First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}

	h.autoExpire(&exam)
	return c.JSON(exam)
}

// GetPublicExam returns an exam without correct_answers fields (for students).
// GET /api/exams/:id/public
func (h *Handler) GetPublicExam(c *fiber.Ctx) error {
	id, _ := strconv.Atoi(c.Params("id"))
	var exam models.Exam
	if err := h.db.Preload("QuestionSets.Questions").First(&exam, id).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}
	// Lazy expiry: if the clock has passed ExamEnd, deactivate and treat as inactive.
	h.autoExpire(&exam)

	if !exam.IsActive {
		return fiber.NewError(fiber.StatusForbidden, "This exam is not yet open. Please wait for your instructor to start the session.")
	}

	hideQuestions := false
	if exam.StartedAt != nil {
		bufferEnd, _, graceEnd := examDeadlines(exam)
		now := time.Now().UTC()
		if !graceEnd.IsZero() && now.After(graceEnd) {
			return fiber.NewError(fiber.StatusGone, "This exam has already concluded.")
		}
		if !bufferEnd.IsZero() && now.Before(bufferEnd) {
			hideQuestions = true
		}
	}

	exam.LoginCode = ""
	pub := publicExamResponse{Exam: exam}
	if !hideQuestions {
		for _, qs := range exam.QuestionSets {
			pqs := publicQuestionSet{QuestionSet: qs}
			for _, q := range qs.Questions {
				pqs.Questions = append(pqs.Questions, publicQuestion{
					ID:               q.ID,
					QuestionSetID:    q.QuestionSetID,
					Type:             q.Type,
					Content:          q.Content,
					Options:          q.Options,
					RandomizeOptions: q.RandomizeOptions,
					Points:           q.Points,
					Language:         q.Language,
				})
			}
			pub.QuestionSets = append(pub.QuestionSets, pqs)
		}
	}
	pub.Exam.QuestionSets = nil

	return c.JSON(pub)
}

// UpdateExam updates fields on an exam owned by the teacher.
// PUT /api/exams/:id
func (h *Handler) UpdateExam(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id, _ := strconv.Atoi(c.Params("id"))
	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", id, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}

	// Parse into a raw map so boolean false values are not skipped by GORM.
	var body map[string]interface{}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	if v, ok := body["duration_minutes"]; ok {
		if d, ok := v.(float64); ok && d <= 0 {
			return fiber.NewError(fiber.StatusBadRequest, "duration_minutes must be greater than 0")
		}
	}
	if v, ok := body["max_code_runs"]; ok {
		if r, ok := v.(float64); ok && (r < 0 || r > 3) {
			return fiber.NewError(fiber.StatusBadRequest, "max_code_runs must be between 0 and 3")
		}
	}

	// Map JSON field names → actual DB column names.
	// GORM derives column names from Go field names (snake_case), NOT from json tags.
	// CameraProctoring field → column "camera_proctoring", but json tag is "camera_proctoring_required".
	// Using the wrong key in a map-based Updates call produces a PostgreSQL
	// "column does not exist" error, so we translate here explicitly.
	jsonToColumn := map[string]string{
		"title":                      "title",
		"description":                "description",
		"duration_minutes":           "duration_minutes",
		"randomize_question_order":   "randomize_question_order",
		"camera_proctoring_required": "camera_proctoring", // json tag ≠ column name
		"violation_limit":            "violation_limit",
		"max_code_runs":              "max_code_runs",
		"login_code":                 "login_code",
		"buffer_duration_minutes":    "buffer_duration_minutes",
	}
	updates := map[string]interface{}{}
	for jsonKey, colName := range jsonToColumn {
		if v, ok := body[jsonKey]; ok {
			updates[colName] = v
		}
	}

	if len(updates) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "no updatable fields provided")
	}

	if err := h.db.Model(&exam).Updates(updates).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to update exam: "+err.Error())
	}
	// Reload to return fully populated exam (including booleans just written).
	h.db.First(&exam, id)
	return c.Status(fiber.StatusOK).JSON(exam)
}

// ToggleExamStatus sets is_active on an exam the teacher owns.
// PATCH /api/exams/:id/status
func (h *Handler) ToggleExamStatus(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id, _ := strconv.Atoi(c.Params("id"))
	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", id, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}

	var body struct {
		IsActive bool `json:"is_active"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	updates := map[string]interface{}{"is_active": body.IsActive}
	if body.IsActive {
		now := time.Now().UTC()
		updates["started_at"] = &now
	}
	if err := h.db.Model(&exam).Updates(updates).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to update exam status")
	}

	h.db.First(&exam, id)
	return c.JSON(exam)
}

// DeleteExam removes an exam and ALL its children inside a transaction to avoid
// FK constraint errors. Children are deleted deepest-first:
//
//	submission_answers → submissions → questions → question_sets → exam
//
// DELETE /api/exams/:id
func (h *Handler) DeleteExam(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id, _ := strconv.Atoi(c.Params("id"))

	// Verify ownership before entering the transaction.
	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", id, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}

	txErr := h.db.Transaction(func(tx *gorm.DB) error {
		// 1a. SubmissionAnswers are children of Submissions — delete deepest first.
		if err := tx.Exec(
			`DELETE FROM submission_answers WHERE submission_id IN
			 (SELECT id FROM submissions WHERE exam_id = ?)`, id,
		).Error; err != nil {
			return err
		}
		// 1b. Submissions reference exam_id directly.
		if err := tx.Where("exam_id = ?", id).Delete(&models.Submission{}).Error; err != nil {
			return err
		}
		// 2. Questions reference question_set_id; sets reference exam_id.
		if err := tx.Exec(
			`DELETE FROM questions WHERE question_set_id IN
			 (SELECT id FROM question_sets WHERE exam_id = ?)`, id,
		).Error; err != nil {
			return err
		}
		// 3. Question sets.
		if err := tx.Where("exam_id = ?", id).Delete(&models.QuestionSet{}).Error; err != nil {
			return err
		}
		// 4. Finally the exam itself.
		return tx.Delete(&exam).Error
	})
	if txErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to delete exam: "+txErr.Error())
	}

	return c.SendStatus(fiber.StatusNoContent)
}
