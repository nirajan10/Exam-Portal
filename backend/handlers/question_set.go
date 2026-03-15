package handlers

import (
	"fmt"
	"strconv"

	"github.com/exam-platform/backend/middleware"
	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

// CreateQuestionSet adds a new question set to an exam owned by the teacher.
// POST /api/question-sets
func (h *Handler) CreateQuestionSet(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	var qs models.QuestionSet
	if err := c.BodyParser(&qs); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if qs.Title == "" || qs.ExamID == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "title and exam_id are required")
	}

	// Verify the exam belongs to this teacher
	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", qs.ExamID, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}

	// Enforce maximum of 5 question sets per exam
	var count int64
	h.db.Model(&models.QuestionSet{}).Where("exam_id = ?", qs.ExamID).Count(&count)
	if count >= 5 {
		return fiber.NewError(fiber.StatusBadRequest, "exam already has the maximum of 5 question sets")
	}

	if result := h.db.Create(&qs); result.Error != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to create question set")
	}

	return c.Status(fiber.StatusCreated).JSON(qs)
}

// UpdateQuestionSet updates a question set owned by the teacher.
// PUT /api/question-sets/:id
func (h *Handler) UpdateQuestionSet(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id, _ := strconv.Atoi(c.Params("id"))

	// Join through exam to verify ownership
	var qs models.QuestionSet
	if err := h.db.Joins("JOIN exams ON exams.id = question_sets.exam_id").
		Where("question_sets.id = ? AND exams.teacher_id = ?", id, teacherID).
		First(&qs).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "question set not found")
	}

	var updates models.QuestionSet
	if err := c.BodyParser(&updates); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	h.db.Model(&qs).Updates(updates)
	return c.JSON(qs)
}

// DuplicateQuestionSet clones a question set and all its questions into the same exam.
// An optional `title` in the JSON body overrides the auto-generated "Set B/C/…" name.
// POST /api/question-sets/:id/duplicate
func (h *Handler) DuplicateQuestionSet(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	srcID, _ := strconv.Atoi(c.Params("id"))

	var src models.QuestionSet
	if err := h.db.Joins("JOIN exams ON exams.id = question_sets.exam_id").
		Where("question_sets.id = ? AND exams.teacher_id = ?", srcID, teacherID).
		First(&src).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "question set not found")
	}

	var srcQuestions []models.Question
	h.db.Where("question_set_id = ?", srcID).Find(&srcQuestions)

	var count int64
	h.db.Model(&models.QuestionSet{}).Where("exam_id = ?", src.ExamID).Count(&count)
	if count >= 5 {
		return fiber.NewError(fiber.StatusBadRequest, "exam already has the maximum of 5 question sets")
	}

	// Read optional title from request body; fall back to auto-generated name.
	var body struct {
		Title string `json:"title"`
	}
	c.BodyParser(&body) //nolint:errcheck — body is optional
	newTitle := body.Title
	if newTitle == "" {
		newTitle = fmt.Sprintf("Set %s", string(rune('A'+int(count))))
	}

	var newSet models.QuestionSet
	txErr := h.db.Transaction(func(tx *gorm.DB) error {
		newSet = models.QuestionSet{ExamID: src.ExamID, Title: newTitle, Order: int(count) + 1}
		if err := tx.Create(&newSet).Error; err != nil {
			return err
		}
		for _, q := range srcQuestions {
			newQ := models.Question{
				QuestionSetID:    newSet.ID,
				Type:             q.Type,
				Content:          q.Content,
				Options:          q.Options,
				CorrectAnswers:   q.CorrectAnswers,
				RandomizeOptions: q.RandomizeOptions,
				Points:           q.Points,
			}
			if err := tx.Create(&newQ).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if txErr != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "duplication failed: "+txErr.Error())
	}

	h.db.Preload("Questions").First(&newSet, newSet.ID)
	return c.Status(fiber.StatusCreated).JSON(newSet)
}

// DeleteQuestionSet removes a question set and all its questions.
// Questions are deleted first to avoid FK constraint errors.
// DELETE /api/question-sets/:id
func (h *Handler) DeleteQuestionSet(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id, _ := strconv.Atoi(c.Params("id"))

	// Verify ownership before deleting.
	var qs models.QuestionSet
	if err := h.db.Joins("JOIN exams ON exams.id = question_sets.exam_id").
		Where("question_sets.id = ? AND exams.teacher_id = ?", id, teacherID).
		First(&qs).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "question set not found")
	}

	// Delete child questions first, then the set.
	h.db.Where("question_set_id = ?", id).Delete(&models.Question{})
	h.db.Delete(&qs)

	return c.SendStatus(fiber.StatusNoContent)
}
