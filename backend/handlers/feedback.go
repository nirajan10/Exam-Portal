package handlers

import (
	"github.com/exam-platform/backend/middleware"
	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
)

// CreateFeedback lets a teacher submit feedback.
// POST /api/feedback
func (h *Handler) CreateFeedback(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "unauthorized")
	}

	var req struct {
		Type    string `json:"type"`
		Subject string `json:"subject"`
		Body    string `json:"body"`
	}
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if req.Type == "" || req.Subject == "" || req.Body == "" {
		return fiber.NewError(fiber.StatusBadRequest, "type, subject, and body are required")
	}

	allowed := map[string]bool{
		"bug": true, "suggestion": true, "usability": true, "performance": true, "other": true,
	}
	if !allowed[req.Type] {
		return fiber.NewError(fiber.StatusBadRequest, "invalid feedback type")
	}

	fb := models.Feedback{
		TeacherID: teacherID,
		Type:      models.FeedbackType(req.Type),
		Subject:   req.Subject,
		Body:      req.Body,
	}
	if err := h.db.Create(&fb).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to create feedback")
	}
	return c.Status(fiber.StatusCreated).JSON(fb)
}

// ListAllFeedback returns all feedback for the admin panel.
// GET /api/admin/feedback
func (h *Handler) ListAllFeedback(c *fiber.Ctx) error {
	var feedbacks []models.Feedback
	if err := h.db.Preload("Teacher").Order("created_at DESC").Find(&feedbacks).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to list feedback")
	}
	return c.JSON(feedbacks)
}

// DeleteFeedback lets an admin delete a feedback entry.
// DELETE /api/admin/feedback/:id
func (h *Handler) DeleteFeedback(c *fiber.Ctx) error {
	id, err := c.ParamsInt("id")
	if err != nil || id == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid feedback id")
	}
	result := h.db.Delete(&models.Feedback{}, id)
	if result.Error != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to delete feedback")
	}
	if result.RowsAffected == 0 {
		return fiber.NewError(fiber.StatusNotFound, "feedback not found")
	}
	return c.SendStatus(fiber.StatusNoContent)
}
