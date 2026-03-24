package handlers

import (
	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
)

// isLLMEnabled checks whether the LLM auto-grader feature is enabled.
func (h *Handler) isLLMEnabled() bool {
	var s models.AppSettings
	if err := h.db.First(&s).Error; err != nil {
		return true // default: enabled
	}
	return s.LLMAutoGrader
}

// GetAppSettings returns platform-wide settings. Any authenticated teacher can
// read these so the frontend knows which features to show.
// GET /api/settings
func (h *Handler) GetAppSettings(c *fiber.Ctx) error {
	var s models.AppSettings
	if err := h.db.First(&s).Error; err != nil {
		// Return safe defaults when the row hasn't been seeded yet.
		return c.JSON(models.AppSettings{LLMAutoGrader: true})
	}
	return c.JSON(s)
}

// UpdateAppSettings lets a superadmin toggle platform-wide feature flags.
// PATCH /api/admin/settings
func (h *Handler) UpdateAppSettings(c *fiber.Ctx) error {
	var req struct {
		LLMAutoGrader *bool `json:"llm_auto_grader"`
	}
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	var s models.AppSettings
	if err := h.db.First(&s).Error; err != nil {
		s = models.AppSettings{ID: 1, LLMAutoGrader: true}
		h.db.Create(&s)
	}

	if req.LLMAutoGrader != nil {
		s.LLMAutoGrader = *req.LLMAutoGrader
	}

	if err := h.db.Save(&s).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to update settings")
	}
	return c.JSON(s)
}
