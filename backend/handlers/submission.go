package handlers

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/exam-platform/backend/middleware"
	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

// ── Offline submission helpers ────────────────────────────────────────────────

const offlineSalt = "exam-salt-2026"

type offlineAnswer struct {
	QuestionID uint   `json:"question_id"`
	Answer     string `json:"answer"`
}

type offlinePayload struct {
	Version      int             `json:"v"`
	ExamID       int             `json:"exam_id"`
	StudentName  string          `json:"student_name"`
	StudentEmail string          `json:"student_email"`
	StudentID    string          `json:"student_id"`
	SetName      string          `json:"set_name"`
	ExportedAt   string          `json:"exported_at"`
	Answers      []offlineAnswer `json:"answers"`
	Hash         string          `json:"hash"`
}

// computeOfflineHash produces a tamper-evident SHA-256 fingerprint for an offline
// submission file. The canonical form sorts answers by question_id ascending and
// uses the same JSON serialisation that both the browser and Go produce by default.
// Hash input: "v{ver}:{exam_id}:{student_name}:{student_email}:{answers_json}:{salt}"
func computeOfflineHash(version int, examID uint, studentName, studentEmail string, answersJSON []byte) string {
	input := fmt.Sprintf("v%d:%d:%s:%s:%s:%s",
		version, examID, studentName, studentEmail, string(answersJSON), offlineSalt)
	h := sha256.Sum256([]byte(input))
	return hex.EncodeToString(h[:])
}

// ── Auto-grading helpers ───────────────────────────────────────────────────────

// scoreAnswer auto-grades MCQ and MRQ questions.
// Returns the full points value if the student answered correctly, else 0.
func scoreAnswer(q models.Question, studentAnswer string) float64 {
	var correct []string
	if err := json.Unmarshal(q.CorrectAnswers, &correct); err != nil || len(correct) == 0 {
		return 0
	}

	if q.Type == models.QuestionTypeMCQ {
		if studentAnswer == correct[0] {
			return float64(q.Points)
		}
		return 0
	}

	// MRQ: student answer is a JSON-encoded string array, e.g. `["A","B"]`
	var studentAnswers []string
	if err := json.Unmarshal([]byte(studentAnswer), &studentAnswers); err != nil {
		return 0
	}
	if sameStringSet(studentAnswers, correct) {
		return float64(q.Points)
	}
	return 0
}

// sameStringSet returns true if a and b contain the same elements regardless of order.
func sameStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	ac := append([]string(nil), a...)
	bc := append([]string(nil), b...)
	sort.Strings(ac)
	sort.Strings(bc)
	for i := range ac {
		if ac[i] != bc[i] {
			return false
		}
	}
	return true
}

// ── Request/response types ────────────────────────────────────────────────────

type submitExamRequest struct {
	StudentName  string `json:"student_name"`
	StudentEmail string `json:"student_email"`
	// SessionID is the value returned by POST /api/exams/:id/join.
	// Stored on the Submission so teachers can identify students by session.
	SessionID    string `json:"session_id"`
	Answers      []struct {
		QuestionID uint   `json:"question_id"`
		Answer     string `json:"answer"`
	} `json:"answers"`
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// SubmitExam records all of a student's answers in one atomic transaction.
// Creates one Submission row + one SubmissionAnswer per question.
// MCQ/MRQ answers are auto-graded immediately; theory/code remain unscored.
// POST /api/exams/:id/submit  (public — no auth required)
func (h *Handler) SubmitExam(c *fiber.Ctx) error {
	examID, _ := strconv.Atoi(c.Params("id"))
	if examID == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid exam id")
	}

	var req submitExamRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if req.StudentName == "" || req.StudentEmail == "" {
		return fiber.NewError(fiber.StatusBadRequest, "student_name and student_email are required")
	}

	now := time.Now().UTC()

	// Guard: reject submissions that arrive after the grace period, regardless of
	// whether the lazy deactivation has already run. This closes the race window.
	var exam models.Exam
	if err := h.db.First(&exam, examID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}
	if exam.StartedAt != nil {
		_, _, graceEnd := examDeadlines(exam)
		if !graceEnd.IsZero() && now.After(graceEnd) {
			// Lazily deactivate so the teacher dashboard reflects the change.
			h.db.Model(&exam).Update("is_active", false)
			return fiber.NewError(fiber.StatusGone, "The exam has already concluded. Submissions are no longer accepted.")
		}
	}

	var submission models.Submission

	txErr := h.db.Transaction(func(tx *gorm.DB) error {
		// 1. Create the parent Submission record.
		submission = models.Submission{
			ExamID:       uint(examID),
			SessionID:    req.SessionID,
			StudentName:  req.StudentName,
			StudentEmail: req.StudentEmail,
			SubmittedAt:  now,
			Status:       models.SubmissionStatusGraded, // optimistic; updated below if theory/code found
		}
		if err := tx.Create(&submission).Error; err != nil {
			return err
		}

		// 2. Bulk-load all referenced questions for auto-grading.
		questionIDs := make([]uint, 0, len(req.Answers))
		for _, a := range req.Answers {
			if a.QuestionID != 0 {
				questionIDs = append(questionIDs, a.QuestionID)
			}
		}
		questionMap := make(map[uint]models.Question)
		if len(questionIDs) > 0 {
			var questions []models.Question
			if err := tx.Where("id IN ?", questionIDs).Find(&questions).Error; err != nil {
				return err
			}
			for _, q := range questions {
				questionMap[q.ID] = q
			}
		}

		// Detect which question set this student received (first non-zero set wins).
		var questionSetID uint
		var setName string
		for _, q := range questionMap {
			if q.QuestionSetID != 0 {
				questionSetID = q.QuestionSetID
				break
			}
		}
		if questionSetID != 0 {
			var qs models.QuestionSet
			if tx.First(&qs, questionSetID).Error == nil {
				setName = qs.Title
			}
		}

		// 3. Create SubmissionAnswer rows; auto-grade MCQ/MRQ.
		// Every question the student was shown is recorded, even if unanswered,
		// so teachers can see which questions were skipped.
		totalScore := 0.0
		hasPending := false
		for _, a := range req.Answers {
			if a.QuestionID == 0 {
				continue
			}
			q, exists := questionMap[a.QuestionID]
			// An empty string or empty JSON array means the student didn't answer.
			unanswered := a.Answer == "" || a.Answer == "[]"
			var score *float64
			if exists {
				switch q.Type {
				case models.QuestionTypeMCQ, models.QuestionTypeMRQ:
					// Auto-grade: empty answer scores 0, wrong answer scores 0.
					s := scoreAnswer(q, a.Answer)
					score = &s
					totalScore += s
				default:
					if unanswered {
						// Nothing to manually grade — award 0 automatically.
						zero := 0.0
						score = &zero
					} else {
						// theory/code with content: requires manual grading.
						hasPending = true
					}
				}
			}
			ans := models.SubmissionAnswer{
				SubmissionID: submission.ID,
				QuestionID:   a.QuestionID,
				Answer:       a.Answer,
				Score:        score,
			}
			if err := tx.Create(&ans).Error; err != nil {
				return err
			}
		}

		// 4. Update total_score, status, and set identity on the parent Submission.
		status := models.SubmissionStatusGraded
		if hasPending {
			status = models.SubmissionStatusPendingGrading
		}
		if err := tx.Model(&submission).Updates(map[string]interface{}{
			"total_score":     totalScore,
			"status":          string(status),
			"question_set_id": questionSetID,
			"set_name":        setName,
		}).Error; err != nil {
			return err
		}
		submission.TotalScore = totalScore
		submission.Status = status
		submission.QuestionSetID = questionSetID
		submission.SetName = setName
		return nil
	})

	if txErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to record submission: "+txErr.Error())
	}

	return c.Status(fiber.StatusCreated).JSON(submission)
}

// ListSubmissions returns all submissions for an exam (teacher-only, no answers preloaded).
// GET /api/submissions?exam_id=1
func (h *Handler) ListSubmissions(c *fiber.Ctx) error {
	examID := c.QueryInt("exam_id", 0)
	if examID == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "exam_id query parameter is required")
	}

	var submissions []models.Submission
	h.db.Where("exam_id = ?", examID).Order("student_name asc").Find(&submissions)
	return c.JSON(submissions)
}

// GetSubmission returns a single submission with all SubmissionAnswers preloaded.
// Used by the teacher grading view.
// GET /api/submissions/:id
func (h *Handler) GetSubmission(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	submissionID, _ := strconv.Atoi(c.Params("id"))
	var submission models.Submission
	if err := h.db.Preload("Answers").First(&submission, submissionID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "submission not found")
	}

	// Verify the teacher owns the exam this submission belongs to.
	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", submission.ExamID, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusForbidden, "access denied")
	}

	return c.JSON(submission)
}

// GradeSubmission lets a teacher award marks and feedback for individual answers.
// Updates each specified SubmissionAnswer then recalculates the parent TotalScore.
// PATCH /api/submissions/:id/grade
func (h *Handler) GradeSubmission(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	submissionID, _ := strconv.Atoi(c.Params("id"))
	var submission models.Submission
	if err := h.db.First(&submission, submissionID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "submission not found")
	}

	// Verify ownership.
	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", submission.ExamID, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusForbidden, "access denied")
	}

	var body struct {
		Grades []struct {
			AnswerID uint    `json:"answer_id"`
			Score    float64 `json:"score"`
			Feedback string  `json:"feedback"`
		} `json:"grades"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	txErr := h.db.Transaction(func(tx *gorm.DB) error {
		for _, g := range body.Grades {
			score := g.Score
			if err := tx.Model(&models.SubmissionAnswer{}).
				Where("id = ? AND submission_id = ?", g.AnswerID, submissionID).
				Updates(map[string]interface{}{
					"score":    score,
					"feedback": g.Feedback,
				}).Error; err != nil {
				return err
			}
		}

		// Recalculate total from all answers.
		var answers []models.SubmissionAnswer
		if err := tx.Where("submission_id = ?", submissionID).Find(&answers).Error; err != nil {
			return err
		}
		total := 0.0
		allGraded := true
		for _, a := range answers {
			if a.Score != nil {
				total += *a.Score
			} else {
				allGraded = false
			}
		}
		status := models.SubmissionStatusPendingGrading
		if allGraded {
			status = models.SubmissionStatusGraded
		}
		gradedBy := models.GradedByHuman
		if submission.GradedBy == models.GradedByAI {
			gradedBy = models.GradedByBoth
		}
		return tx.Model(&submission).Updates(map[string]interface{}{
			"total_score": total,
			"status":      string(status),
			"graded_by":   string(gradedBy),
		}).Error
	})

	if txErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "grading failed: "+txErr.Error())
	}

	h.db.Preload("Answers").First(&submission, submissionID)
	return c.JSON(submission)
}

// DeleteSubmission permanently removes a submission and all its answers.
// The DB cascade (OnDelete:CASCADE on submission_answers.submission_id) handles
// child rows automatically on databases where the constraint is present.
// For older databases without the constraint, we delete children explicitly first.
// DELETE /api/submissions/:id
func (h *Handler) DeleteSubmission(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	submissionID, _ := strconv.Atoi(c.Params("id"))
	if submissionID == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid submission id")
	}

	// Load to verify existence and get exam_id for ownership check.
	var submission models.Submission
	if err := h.db.First(&submission, submissionID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "submission not found")
	}

	// Verify the teacher owns the exam this submission belongs to.
	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", submission.ExamID, teacherID).
		First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusForbidden, "access denied")
	}

	// Delete children first (guards against existing DBs without CASCADE).
	if err := h.db.Where("submission_id = ?", submissionID).
		Delete(&models.SubmissionAnswer{}).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to delete submission answers")
	}

	// Delete the parent submission.
	if err := h.db.Delete(&submission).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to delete submission")
	}

	return c.SendStatus(fiber.StatusNoContent)
}

// CreateSubmission is kept as a stub for backwards compatibility.
// The active endpoint is POST /api/exams/:id/submit.
func (h *Handler) CreateSubmission(c *fiber.Ctx) error {
	return fiber.NewError(fiber.StatusGone, "use POST /api/exams/:id/submit instead")
}

// ── Exam analytics ─────────────────────────────────────────────────────────────

type questionStat struct {
	QuestionID      uint    `json:"question_id"`
	QuestionContent string  `json:"question_content"`
	QuestionType    string  `json:"question_type"`
	CorrectCount    int     `json:"correct_count"`
	TotalAttempts   int     `json:"total_attempts"`
	MaxPoints       int     `json:"max_points"`
}

type examAnalyticsResponse struct {
	SubmissionCount  int            `json:"submission_count"`
	AvgScore         float64        `json:"avg_score"`
	MaxPossibleScore int            `json:"max_possible_score"`
	PassRate         float64        `json:"pass_rate"`
	AvgCompletionMins *float64      `json:"avg_completion_mins"`
	ScoreBuckets     [3]int         `json:"score_buckets"`
	QuestionStats    []questionStat `json:"question_stats"`
}

// GetExamAnalytics returns server-side aggregated analytics for an exam.
// Computes score buckets, per-question correctness rates, pass rate, and
// average completion time — all in a single round-trip.
// GET /api/exams/:id/analytics  (JWT-protected)
func (h *Handler) GetExamAnalytics(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	examID, _ := strconv.Atoi(c.Params("id"))

	// Load exam with all question sets and questions.
	var exam models.Exam
	if err := h.db.Preload("QuestionSets.Questions").First(&exam, examID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}
	if exam.TeacherID != uint(teacherID) {
		return fiber.NewError(fiber.StatusForbidden, "access denied")
	}

	// Load all submissions (scores and timestamps only — no answers preloaded).
	var submissions []models.Submission
	h.db.Where("exam_id = ?", examID).Find(&submissions)

	n := len(submissions)

	// Compute max possible score from the first question set (sorted by order).
	sort.Slice(exam.QuestionSets, func(i, j int) bool {
		return exam.QuestionSets[i].Order < exam.QuestionSets[j].Order
	})
	maxPossible := 0
	if len(exam.QuestionSets) > 0 {
		for _, q := range exam.QuestionSets[0].Questions {
			maxPossible += q.Points
		}
	}

	// Empty exam: return zeroed response rather than dividing by zero.
	if n == 0 {
		return c.JSON(examAnalyticsResponse{
			MaxPossibleScore: maxPossible,
			QuestionStats:    []questionStat{},
		})
	}

	// Aggregate score statistics and completion times.
	var totalScore float64
	var buckets [3]int
	var completionSecs []float64

	for _, s := range submissions {
		totalScore += s.TotalScore
		pct := 0.0
		if maxPossible > 0 {
			pct = (s.TotalScore / float64(maxPossible)) * 100
		}
		switch {
		case pct <= 40:
			buckets[0]++
		case pct <= 70:
			buckets[1]++
		default:
			buckets[2]++
		}
		if exam.StartedAt != nil {
			t0 := exam.StartedAt.Add(time.Duration(exam.BufferDurationMins) * time.Minute)
			secs := s.SubmittedAt.Sub(t0).Seconds()
			if secs > 0 {
				completionSecs = append(completionSecs, secs)
			}
		}
	}

	avgScore := totalScore / float64(n)
	passing := float64(buckets[1] + buckets[2])
	passRate := (passing / float64(n)) * 100

	var avgCompletionMins *float64
	if len(completionSecs) > 0 {
		sum := 0.0
		for _, s := range completionSecs {
			sum += s
		}
		avg := (sum / float64(len(completionSecs))) / 60.0
		avgCompletionMins = &avg
	}

	// Build a flat question map for all sets.
	qMap := make(map[uint]models.Question)
	for _, qs := range exam.QuestionSets {
		for _, q := range qs.Questions {
			qMap[q.ID] = q
		}
	}

	// Fetch all submission answers for this exam in one query.
	type answerRow struct {
		QuestionID uint     `gorm:"column:question_id"`
		Score      *float64 `gorm:"column:score"`
		Answer     string   `gorm:"column:answer"`
	}
	var answerRows []answerRow
	h.db.Raw(`
		SELECT sa.question_id, sa.score, sa.answer
		FROM submission_answers sa
		INNER JOIN submissions s ON sa.submission_id = s.id
		WHERE s.exam_id = ?`, examID).Scan(&answerRows)

	// Per-question aggregation (MCQ and MRQ only).
	type qAgg struct{ correct, total int }
	aggMap := make(map[uint]*qAgg)
	for _, ar := range answerRows {
		q, ok := qMap[ar.QuestionID]
		if !ok || (q.Type != models.QuestionTypeMCQ && q.Type != models.QuestionTypeMRQ) {
			continue
		}
		if aggMap[ar.QuestionID] == nil {
			aggMap[ar.QuestionID] = &qAgg{}
		}
		agg := aggMap[ar.QuestionID]
		if ar.Answer != "" && ar.Answer != "[]" {
			agg.total++
			if ar.Score != nil && *ar.Score > 0 {
				agg.correct++
			}
		}
	}

	// Build ordered question stats (preserve set → question order).
	var qStats []questionStat
	for _, qs := range exam.QuestionSets {
		for _, q := range qs.Questions {
			if q.Type != models.QuestionTypeMCQ && q.Type != models.QuestionTypeMRQ {
				continue
			}
			stat := questionStat{
				QuestionID:      q.ID,
				QuestionContent: q.Content,
				QuestionType:    string(q.Type),
				MaxPoints:       q.Points,
			}
			if agg := aggMap[q.ID]; agg != nil {
				stat.CorrectCount = agg.correct
				stat.TotalAttempts = agg.total
			}
			qStats = append(qStats, stat)
		}
	}
	if qStats == nil {
		qStats = []questionStat{}
	}

	return c.JSON(examAnalyticsResponse{
		SubmissionCount:   n,
		AvgScore:          avgScore,
		MaxPossibleScore:  maxPossible,
		PassRate:          passRate,
		AvgCompletionMins: avgCompletionMins,
		ScoreBuckets:      buckets,
		QuestionStats:     qStats,
	})
}

// ── Offline import shared helpers ─────────────────────────────────────────────

// parseOfflineEnvelope decodes and validates the common { "data": "<base64>" }
// request body used by both offline import endpoints.
func parseOfflineEnvelope(c *fiber.Ctx) (offlinePayload, error) {
	var envelope struct {
		Data string `json:"data"`
	}
	if err := c.BodyParser(&envelope); err != nil || envelope.Data == "" {
		return offlinePayload{}, fiber.NewError(fiber.StatusBadRequest, "request body must be JSON with a 'data' field")
	}

	// Decode base64 — tolerate both standard and URL-safe variants.
	jsonBytes, err := base64.StdEncoding.DecodeString(envelope.Data)
	if err != nil {
		jsonBytes, err = base64.URLEncoding.DecodeString(envelope.Data)
		if err != nil {
			return offlinePayload{}, fiber.NewError(fiber.StatusBadRequest, "invalid file: base64 decoding failed")
		}
	}

	var payload offlinePayload
	if err := json.Unmarshal(jsonBytes, &payload); err != nil {
		return offlinePayload{}, fiber.NewError(fiber.StatusBadRequest, "invalid file: malformed JSON")
	}
	if payload.Version != 1 {
		return offlinePayload{}, fiber.NewError(fiber.StatusBadRequest, "unsupported file version")
	}
	if payload.StudentName == "" || payload.StudentEmail == "" {
		return offlinePayload{}, fiber.NewError(fiber.StatusBadRequest, "file is missing student information")
	}
	if len(payload.Answers) == 0 {
		return offlinePayload{}, fiber.NewError(fiber.StatusBadRequest, "file contains no answers")
	}

	// Re-sort by question_id for canonical hash comparison.
	sorted := make([]offlineAnswer, len(payload.Answers))
	copy(sorted, payload.Answers)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].QuestionID < sorted[j].QuestionID })

	answersJSON, err := json.Marshal(sorted)
	if err != nil {
		return offlinePayload{}, fiber.NewError(fiber.StatusInternalServerError, "failed to canonicalise answers")
	}

	expected := computeOfflineHash(payload.Version, uint(payload.ExamID), payload.StudentName, payload.StudentEmail, answersJSON)
	if expected != payload.Hash {
		return offlinePayload{}, fiber.NewError(fiber.StatusUnprocessableEntity,
			"tamper detected: hash mismatch — the file has been modified and cannot be imported")
	}

	return payload, nil
}

// runOfflineImportTx inserts a verified offline payload into the database using
// the same transaction logic as SubmitExam.
func (h *Handler) runOfflineImportTx(payload offlinePayload) (models.Submission, error) {
	req := submitExamRequest{
		StudentName:  payload.StudentName,
		StudentEmail: payload.StudentEmail,
	}
	for _, a := range payload.Answers {
		req.Answers = append(req.Answers, struct {
			QuestionID uint   `json:"question_id"`
			Answer     string `json:"answer"`
		}{QuestionID: a.QuestionID, Answer: a.Answer})
	}

	now := time.Now().UTC()
	var submission models.Submission

	txErr := h.db.Transaction(func(tx *gorm.DB) error {
		submission = models.Submission{
			ExamID:       uint(payload.ExamID),
			SessionID:    payload.StudentID, // offline file stores session ID in student_id field
			StudentName:  req.StudentName,
			StudentEmail: req.StudentEmail,
			SubmittedAt:  now,
			Status:       models.SubmissionStatusGraded,
		}
		if err := tx.Create(&submission).Error; err != nil {
			return err
		}

		questionIDs := make([]uint, 0, len(req.Answers))
		for _, a := range req.Answers {
			if a.QuestionID != 0 {
				questionIDs = append(questionIDs, a.QuestionID)
			}
		}
		questionMap := make(map[uint]models.Question)
		if len(questionIDs) > 0 {
			var questions []models.Question
			if err := tx.Where("id IN ?", questionIDs).Find(&questions).Error; err != nil {
				return err
			}
			for _, q := range questions {
				questionMap[q.ID] = q
			}
		}

		var questionSetID uint
		var setName string
		for _, q := range questionMap {
			if q.QuestionSetID != 0 {
				questionSetID = q.QuestionSetID
				break
			}
		}
		if questionSetID != 0 {
			var qs models.QuestionSet
			if tx.First(&qs, questionSetID).Error == nil {
				setName = qs.Title
			}
		}

		totalScore := 0.0
		hasPending := false
		for _, a := range req.Answers {
			if a.QuestionID == 0 {
				continue
			}
			q, exists := questionMap[a.QuestionID]
			unanswered := a.Answer == "" || a.Answer == "[]"
			var score *float64
			if exists {
				switch q.Type {
				case models.QuestionTypeMCQ, models.QuestionTypeMRQ:
					s := scoreAnswer(q, a.Answer)
					score = &s
					totalScore += s
				default:
					if unanswered {
						zero := 0.0
						score = &zero
					} else {
						hasPending = true
					}
				}
			}
			if err := tx.Create(&models.SubmissionAnswer{
				SubmissionID: submission.ID,
				QuestionID:   a.QuestionID,
				Answer:       a.Answer,
				Score:        score,
			}).Error; err != nil {
				return err
			}
		}

		status := models.SubmissionStatusGraded
		if hasPending {
			status = models.SubmissionStatusPendingGrading
		}
		if err := tx.Model(&submission).Updates(map[string]interface{}{
			"total_score":     totalScore,
			"status":          string(status),
			"question_set_id": questionSetID,
			"set_name":        setName,
		}).Error; err != nil {
			return err
		}
		submission.TotalScore = totalScore
		submission.Status = status
		submission.QuestionSetID = questionSetID
		submission.SetName = setName
		return nil
	})

	return submission, txErr
}

// remapOfflineQuestionIDs maps question IDs from an offline submission file to
// the target exam's question IDs. This handles the case where the exam was
// deleted and reimported — same questions exist but with new DB IDs. Matching
// is done positionally within the question set identified by payload.SetName.
func (h *Handler) remapOfflineQuestionIDs(payload *offlinePayload, targetExamID uint) error {
	// Find question sets in the target exam.
	var targetSets []models.QuestionSet
	if err := h.db.Where("exam_id = ?", targetExamID).Order("\"order\" ASC, id ASC").
		Find(&targetSets).Error; err != nil || len(targetSets) == 0 {
		return fmt.Errorf("target exam has no question sets")
	}

	// Match by set_name; fall back to single-set exam.
	var matchedSet *models.QuestionSet
	if payload.SetName != "" {
		for i := range targetSets {
			if targetSets[i].Title == payload.SetName {
				matchedSet = &targetSets[i]
				break
			}
		}
	}
	if matchedSet == nil && len(targetSets) == 1 {
		matchedSet = &targetSets[0]
	}
	if matchedSet == nil {
		return fmt.Errorf("could not match question set %q in target exam", payload.SetName)
	}

	// Load questions from the matched set in creation order.
	var targetQuestions []models.Question
	if err := h.db.Where("question_set_id = ?", matchedSet.ID).
		Order("id ASC").Find(&targetQuestions).Error; err != nil {
		return fmt.Errorf("could not load questions from target exam")
	}

	// Collect unique old question IDs in sorted order.
	seen := map[uint]bool{}
	oldIDs := make([]uint, 0, len(payload.Answers))
	for _, a := range payload.Answers {
		if a.QuestionID != 0 && !seen[a.QuestionID] {
			seen[a.QuestionID] = true
			oldIDs = append(oldIDs, a.QuestionID)
		}
	}
	sort.Slice(oldIDs, func(i, j int) bool { return oldIDs[i] < oldIDs[j] })

	if len(oldIDs) != len(targetQuestions) {
		return fmt.Errorf(
			"question count mismatch: offline file has %d questions, target set %q has %d",
			len(oldIDs), matchedSet.Title, len(targetQuestions))
	}

	// Positional remap: sorted old ID[i] → target question ID[i].
	remap := make(map[uint]uint, len(oldIDs))
	for i, oldID := range oldIDs {
		remap[oldID] = targetQuestions[i].ID
	}

	for i := range payload.Answers {
		if newID, ok := remap[payload.Answers[i].QuestionID]; ok {
			payload.Answers[i].QuestionID = newID
		}
	}
	payload.ExamID = int(targetExamID)
	return nil
}

// ── Import handlers ───────────────────────────────────────────────────────────

// ImportOfflineSubmission imports a backup file for a specific exam (exam id in URL).
// POST /api/exams/:id/import-offline  — JWT-protected
func (h *Handler) ImportOfflineSubmission(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	examID, _ := strconv.Atoi(c.Params("id"))
	if examID == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid exam id")
	}

	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", examID, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusForbidden, "exam not found or access denied")
	}

	payload, err := parseOfflineEnvelope(c)
	if err != nil {
		return err
	}

	// If the file was created for a different exam (e.g. exam was deleted and
	// reimported), remap question IDs to match the target exam.
	if payload.ExamID != examID {
		if err := h.remapOfflineQuestionIDs(&payload, uint(examID)); err != nil {
			return fiber.NewError(fiber.StatusBadRequest,
				"cannot remap offline submission to this exam: "+err.Error())
		}
	}

	submission, txErr := h.runOfflineImportTx(payload)
	if txErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to import submission: "+txErr.Error())
	}
	return c.Status(fiber.StatusCreated).JSON(submission)
}

// ImportOfflineAuto imports a backup file without requiring the exam id in the URL —
// the exam id is read from the file itself. The teacher must still own that exam.
// POST /api/submissions/import  — JWT-protected
func (h *Handler) ImportOfflineAuto(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	payload, err := parseOfflineEnvelope(c)
	if err != nil {
		return err
	}
	if payload.ExamID == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "file does not contain a valid exam_id")
	}

	// Verify teacher owns the exam embedded in the file.
	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", payload.ExamID, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusForbidden, "exam not found or access denied")
	}

	submission, txErr := h.runOfflineImportTx(payload)
	if txErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to import submission: "+txErr.Error())
	}
	return c.Status(fiber.StatusCreated).JSON(submission)
}

