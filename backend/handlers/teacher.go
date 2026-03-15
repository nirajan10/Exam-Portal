package handlers

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/exam-platform/backend/middleware"
	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
)

// GetMe returns the authenticated teacher's profile.
// GET /api/me
func (h *Handler) GetMe(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	var teacher models.Teacher
	if err := h.db.First(&teacher, teacherID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "teacher not found")
	}

	return c.JSON(teacher)
}

// UpdateProfilePic handles a profile picture upload for the authenticated teacher.
// The file is stored in ./uploads/profile_pics/ and its URL path is saved to the DB.
// POST /api/me/profile-pic  (multipart/form-data field: "picture")
func (h *Handler) UpdateProfilePic(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	fh, err := c.FormFile("picture")
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, `multipart field "picture" is required`)
	}

	// Allow only common image types.
	ext := strings.ToLower(filepath.Ext(fh.Filename))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp":
		// ok
	default:
		return fiber.NewError(fiber.StatusBadRequest, "only JPEG, PNG, GIF, and WebP images are accepted")
	}

	// Ensure the upload directory exists.
	uploadDir := "./uploads/profile_pics"
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to create upload directory")
	}

	// File name: <teacherID>_<timestamp><ext> — deterministic per teacher, no collisions.
	filename := fmt.Sprintf("%d_%d%s", teacherID, time.Now().UnixMilli(), ext)
	savePath := filepath.Join(uploadDir, filename)

	if err := c.SaveFile(fh, savePath); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to save uploaded file")
	}

	// URL path served by the /uploads static handler in main.go.
	urlPath := "/uploads/profile_pics/" + filename

	var teacher models.Teacher
	if err := h.db.First(&teacher, teacherID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "teacher not found")
	}

	if err := h.db.Model(&teacher).Update("profile_pic", urlPath).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to update profile picture")
	}

	return c.JSON(teacher)
}
