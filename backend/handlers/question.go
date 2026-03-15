package handlers

import (
	"strconv"

	"github.com/exam-platform/backend/middleware"
	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
	"gorm.io/datatypes"
)

// CreateQuestion adds a question to a question set owned by the teacher.
// POST /api/questions
func (h *Handler) CreateQuestion(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	var q models.Question
	if err := c.BodyParser(&q); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if q.Content == "" || q.QuestionSetID == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "content and question_set_id are required")
	}
	if q.Type != models.QuestionTypeMCQ && q.Type != models.QuestionTypeMRQ &&
		q.Type != models.QuestionTypeCode && q.Type != models.QuestionTypeTheory {
		return fiber.NewError(fiber.StatusBadRequest, "type must be MCQ, MRQ, code, or theory")
	}

	// Verify ownership via question_set → exam → teacher
	var qs models.QuestionSet
	if err := h.db.Joins("JOIN exams ON exams.id = question_sets.exam_id").
		Where("question_sets.id = ? AND exams.teacher_id = ?", q.QuestionSetID, teacherID).
		First(&qs).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "question set not found")
	}

	if result := h.db.Create(&q); result.Error != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to create question")
	}

	return c.Status(fiber.StatusCreated).JSON(q)
}

// UpdateQuestion updates a question owned by the teacher.
// PUT /api/questions/:id
func (h *Handler) UpdateQuestion(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id, _ := strconv.Atoi(c.Params("id"))
	var q models.Question
	if err := h.db.Joins("JOIN question_sets ON question_sets.id = questions.question_set_id").
		Joins("JOIN exams ON exams.id = question_sets.exam_id").
		Where("questions.id = ? AND exams.teacher_id = ?", id, teacherID).
		First(&q).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "question not found")
	}

	var body struct {
		Type             models.QuestionType `json:"type"`
		Content          string              `json:"content"`
		Options          datatypes.JSON      `json:"options"`
		CorrectAnswers   datatypes.JSON      `json:"correct_answers"`
		RandomizeOptions bool                `json:"randomize_options"`
		Points           int                 `json:"points"`
		Language         string              `json:"language"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	// Allow type changes strictly between MCQ and MRQ — the only safe switch
	// because both share the same options/correct_answers structure.
	// Changing to/from code or theory would orphan or corrupt those fields.
	if body.Type != "" && body.Type != q.Type {
		isChoiceSwitch := (q.Type == models.QuestionTypeMCQ || q.Type == models.QuestionTypeMRQ) &&
			(body.Type == models.QuestionTypeMCQ || body.Type == models.QuestionTypeMRQ)
		if !isChoiceSwitch {
			return fiber.NewError(fiber.StatusBadRequest, "type can only be changed between MCQ and MRQ")
		}
		q.Type = body.Type
	}

	// Apply remaining fields; zero-values (false, 0) are preserved via Save.
	q.Content = body.Content
	q.Options = body.Options
	q.CorrectAnswers = body.CorrectAnswers
	q.RandomizeOptions = body.RandomizeOptions
	q.Points = body.Points
	q.Language = body.Language

	if err := h.db.Save(&q).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to update question")
	}
	return c.JSON(q)
}

// DeleteQuestion removes a question owned by the teacher.
// Child submissions are deleted first to satisfy FK constraints.
// DELETE /api/questions/:id
func (h *Handler) DeleteQuestion(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id, _ := strconv.Atoi(c.Params("id"))

	// Verify ownership via JOIN before touching any rows.
	// PostgreSQL does not support JOIN in DELETE directly, so we SELECT first.
	var q models.Question
	if err := h.db.
		Joins("JOIN question_sets ON question_sets.id = questions.question_set_id").
		Joins("JOIN exams ON exams.id = question_sets.exam_id").
		Where("questions.id = ? AND exams.teacher_id = ?", id, teacherID).
		First(&q).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "question not found")
	}

	// Delete child answers first (FK: submission_answers.question_id → questions.id).
	if err := h.db.Where("question_id = ?", id).Delete(&models.SubmissionAnswer{}).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to remove related answers")
	}

	// Now safe to delete the question.
	if err := h.db.Delete(&q).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to delete question")
	}

	return c.SendStatus(fiber.StatusNoContent)
}
