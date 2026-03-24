package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/exam-platform/backend/middleware"
	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// ── Whole-exam export / import ───────────────────────────────────────────────

type exportAnswer struct {
	QuestionID uint     `json:"question_id"`
	Answer     string   `json:"answer"`
	Score      *float64 `json:"score"`
	Feedback   string   `json:"feedback"`
}

type exportSubmission struct {
	SessionID     string         `json:"session_id"`
	SetName       string         `json:"set_name"`
	StudentName   string         `json:"student_name"`
	StudentEmail  string         `json:"student_email"`
	SubmittedAt   string         `json:"submitted_at"`
	TotalScore    float64        `json:"total_score"`
	Status        string         `json:"status"`
	Answers       []exportAnswer `json:"answers"`
}

type exportQuestion struct {
	// LocalID is a file-local reference so submission answers can map back to questions.
	LocalID          int              `json:"local_id"`
	Type             string           `json:"type"`
	Content          string           `json:"content"`
	Options          json.RawMessage  `json:"options"`
	CorrectAnswers   json.RawMessage  `json:"correct_answers"`
	RandomizeOptions bool             `json:"randomize_options"`
	Points           int              `json:"points"`
	Language         string           `json:"language"`
}

type exportQuestionSet struct {
	Title     string           `json:"title"`
	Order     int              `json:"order"`
	Questions []exportQuestion `json:"questions"`
}

type exportExam struct {
	Title                  string `json:"title"`
	Description            string `json:"description"`
	DurationMinutes        int    `json:"duration_minutes"`
	BufferDurationMinutes  int    `json:"buffer_duration_minutes"`
	RandomizeQuestionOrder bool   `json:"randomize_question_order"`
	CameraProctoring       bool   `json:"camera_proctoring_required"`
	ViolationLimit         int    `json:"violation_limit"`
	MaxCodeRuns            int    `json:"max_code_runs"`
	LoginCode              string `json:"login_code"`
}

type wholeExamPayload struct {
	Version      int                 `json:"v"`
	ExportedAt   string              `json:"exported_at"`
	Exam         exportExam          `json:"exam"`
	QuestionSets []exportQuestionSet `json:"question_sets"`
	Submissions  []exportSubmission  `json:"submissions"`
	Hash         string              `json:"hash"`
}

const wholeExamSalt = "exam-export-v1-integrity"

func computeWholeExamHash(content []byte) string {
	input := fmt.Sprintf("exam-v1:%s:%s", string(content), wholeExamSalt)
	h := sha256.Sum256([]byte(input))
	return hex.EncodeToString(h[:])
}

// ExportWholeExam exports the entire exam (metadata, question sets, questions,
// and submissions) as a portable JSON file. The file is ID-free so any teacher
// can import it on any instance.
// GET /api/exams/:id/export
func (h *Handler) ExportWholeExam(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id, _ := strconv.Atoi(c.Params("id"))
	if id == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid exam id")
	}

	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", id, teacherID).
		Preload("QuestionSets.Questions").
		First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusForbidden, "exam not found or access denied")
	}

	// Build a map from DB question ID → local_id so submissions can reference questions.
	questionIDMap := map[uint]int{}
	localID := 1

	sets := make([]exportQuestionSet, 0, len(exam.QuestionSets))
	for _, qs := range exam.QuestionSets {
		questions := make([]exportQuestion, 0, len(qs.Questions))
		for _, q := range qs.Questions {
			questionIDMap[q.ID] = localID
			questions = append(questions, exportQuestion{
				LocalID:          localID,
				Type:             string(q.Type),
				Content:          q.Content,
				Options:          json.RawMessage(q.Options),
				CorrectAnswers:   json.RawMessage(q.CorrectAnswers),
				RandomizeOptions: q.RandomizeOptions,
				Points:           q.Points,
				Language:         q.Language,
			})
			localID++
		}
		sets = append(sets, exportQuestionSet{
			Title:     qs.Title,
			Order:     qs.Order,
			Questions: questions,
		})
	}

	// Export submissions.
	var submissions []models.Submission
	h.db.Preload("Answers").Where("exam_id = ?", id).Order("submitted_at desc").Find(&submissions)

	exported := make([]exportSubmission, 0, len(submissions))
	for _, s := range submissions {
		answers := make([]exportAnswer, 0, len(s.Answers))
		for _, a := range s.Answers {
			answers = append(answers, exportAnswer{
				QuestionID: uint(questionIDMap[a.QuestionID]),
				Answer:     a.Answer,
				Score:      a.Score,
				Feedback:   a.Feedback,
			})
		}
		exported = append(exported, exportSubmission{
			SessionID:    s.SessionID,
			SetName:      s.SetName,
			StudentName:  s.StudentName,
			StudentEmail: s.StudentEmail,
			SubmittedAt:  s.SubmittedAt.Format(time.RFC3339),
			TotalScore:   s.TotalScore,
			Status:       string(s.Status),
			Answers:      answers,
		})
	}

	examData := exportExam{
		Title:                  exam.Title,
		Description:            exam.Description,
		DurationMinutes:        exam.DurationMinutes,
		BufferDurationMinutes:  exam.BufferDurationMins,
		RandomizeQuestionOrder: exam.RandomizeQuestionOrder,
		CameraProctoring:       exam.CameraProctoring,
		ViolationLimit:         exam.ViolationLimit,
		MaxCodeRuns:            exam.MaxCodeRuns,
		LoginCode:              exam.LoginCode,
	}

	// Build payload without hash first to compute hash over the content.
	payload := wholeExamPayload{
		Version:      1,
		ExportedAt:   time.Now().UTC().Format(time.RFC3339),
		Exam:         examData,
		QuestionSets: sets,
		Submissions:  exported,
	}

	contentJSON, _ := json.Marshal(struct {
		Exam         exportExam          `json:"exam"`
		QuestionSets []exportQuestionSet `json:"question_sets"`
		Submissions  []exportSubmission  `json:"submissions"`
	}{payload.Exam, payload.QuestionSets, payload.Submissions})

	payload.Hash = computeWholeExamHash(contentJSON)

	c.Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.examfull"`, exam.Title))
	c.Set("Content-Type", "application/json")
	return c.JSON(payload)
}

// ImportWholeExam imports a previously-exported whole exam file and creates a
// new exam owned by the importing teacher. No IDs from the source are preserved.
// POST /api/exams/import
func (h *Handler) ImportWholeExam(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	var payload wholeExamPayload
	if err := c.BodyParser(&payload); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid file format")
	}
	if payload.Version != 1 {
		return fiber.NewError(fiber.StatusBadRequest, "unsupported file version")
	}

	// Verify hash.
	contentJSON, _ := json.Marshal(struct {
		Exam         exportExam          `json:"exam"`
		QuestionSets []exportQuestionSet `json:"question_sets"`
		Submissions  []exportSubmission  `json:"submissions"`
	}{payload.Exam, payload.QuestionSets, payload.Submissions})

	expected := computeWholeExamHash(contentJSON)
	if expected != payload.Hash {
		return fiber.NewError(fiber.StatusUnprocessableEntity,
			"tamper detected: hash mismatch — the file has been modified")
	}

	// Create everything inside a single transaction.
	var newExamID uint
	txErr := h.db.Transaction(func(tx *gorm.DB) error {
		// 1. Create the exam.
		exam := models.Exam{
			TeacherID:              teacherID,
			Title:                  payload.Exam.Title,
			Description:            payload.Exam.Description,
			DurationMinutes:        payload.Exam.DurationMinutes,
			BufferDurationMins:     payload.Exam.BufferDurationMinutes,
			RandomizeQuestionOrder: payload.Exam.RandomizeQuestionOrder,
			CameraProctoring:       payload.Exam.CameraProctoring,
			ViolationLimit:         payload.Exam.ViolationLimit,
			MaxCodeRuns:            payload.Exam.MaxCodeRuns,
			LoginCode:              payload.Exam.LoginCode,
		}
		if err := tx.Create(&exam).Error; err != nil {
			return fmt.Errorf("create exam: %w", err)
		}
		newExamID = exam.ID

		// 2. Create question sets and questions. Track local_id → new DB ID.
		localToDBQuestion := map[int]uint{}

		for _, qs := range payload.QuestionSets {
			set := models.QuestionSet{
				ExamID: exam.ID,
				Title:  qs.Title,
				Order:  qs.Order,
			}
			if err := tx.Create(&set).Error; err != nil {
				return fmt.Errorf("create question set %q: %w", qs.Title, err)
			}

			for _, q := range qs.Questions {
				question := models.Question{
					QuestionSetID:    set.ID,
					Type:             models.QuestionType(q.Type),
					Content:          q.Content,
					Options:          datatypes.JSON(q.Options),
					CorrectAnswers:   datatypes.JSON(q.CorrectAnswers),
					RandomizeOptions: q.RandomizeOptions,
					Points:           q.Points,
					Language:         q.Language,
				}
				if err := tx.Create(&question).Error; err != nil {
					return fmt.Errorf("create question: %w", err)
				}
				localToDBQuestion[q.LocalID] = question.ID
			}
		}

		// 3. Create submissions and answers.
		for _, sub := range payload.Submissions {
			submittedAt, _ := time.Parse(time.RFC3339, sub.SubmittedAt)
			if submittedAt.IsZero() {
				submittedAt = time.Now().UTC()
			}

			submission := models.Submission{
				ExamID:       exam.ID,
				SessionID:    sub.SessionID,
				StudentName:  sub.StudentName,
				StudentEmail: sub.StudentEmail,
				SetName:      sub.SetName,
				SubmittedAt:  submittedAt,
				TotalScore:   sub.TotalScore,
				Status:       models.SubmissionStatus(sub.Status),
			}
			if err := tx.Create(&submission).Error; err != nil {
				return fmt.Errorf("create submission for %s: %w", sub.StudentEmail, err)
			}

			for _, a := range sub.Answers {
				dbQuestionID := localToDBQuestion[int(a.QuestionID)]
				if dbQuestionID == 0 {
					continue // skip answers for unknown questions
				}
				if err := tx.Create(&models.SubmissionAnswer{
					SubmissionID: submission.ID,
					QuestionID:   dbQuestionID,
					Answer:       a.Answer,
					Score:        a.Score,
					Feedback:     a.Feedback,
				}).Error; err != nil {
					return fmt.Errorf("create answer: %w", err)
				}
			}
		}

		return nil
	})

	if txErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError,
			fmt.Sprintf("import failed: %v", txErr))
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"exam_id": newExamID,
		"message": fmt.Sprintf("Exam %q imported with %d question set(s) and %d submission(s)",
			payload.Exam.Title, len(payload.QuestionSets), len(payload.Submissions)),
	})
}
