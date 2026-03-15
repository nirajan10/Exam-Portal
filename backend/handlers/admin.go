package handlers

import (
	"crypto/rand"
	"math/big"
	"strconv"

	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
	"golang.org/x/crypto/bcrypt"
)

// randPassword generates a cryptographically-random 8-character temporary
// password from an unambiguous character set (no 0/O, 1/l/I).
func randPassword() string {
	const charset = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 8)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		b[i] = charset[n.Int64()]
	}
	return string(b)
}

// ListTeachers returns all teacher accounts (excludes superadmins).
// GET /api/admin/teachers
func (h *Handler) ListTeachers(c *fiber.Ctx) error {
	var teachers []models.Teacher
	if err := h.db.Where("role = ?", models.RoleTeacher).
		Order("created_at ASC").Find(&teachers).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to list teachers")
	}
	return c.JSON(teachers)
}

// CreateTeacher creates a new teacher account with an auto-generated password.
// The plain-text password is returned once so the admin can hand it to the teacher.
// POST /api/admin/create-teacher
func (h *Handler) CreateTeacher(c *fiber.Ctx) error {
	var req struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	}
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if req.Name == "" || req.Email == "" {
		return fiber.NewError(fiber.StatusBadRequest, "name and email are required")
	}

	tempPassword := randPassword()
	hashed, err := bcrypt.GenerateFromPassword([]byte(tempPassword), 12)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to hash password")
	}

	teacher := models.Teacher{
		Name:               req.Name,
		Email:              req.Email,
		HashedPassword:     string(hashed),
		Role:               models.RoleTeacher,
		IsActive:           true,
		MustChangePassword: true,
	}
	if result := h.db.Create(&teacher); result.Error != nil {
		return fiber.NewError(fiber.StatusConflict, "email already registered")
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"teacher":       teacher,
		"temp_password": tempPassword,
	})
}

// ResetTeacherPassword generates a new random password for a teacher and
// forces them to change it on next login.
// PATCH /api/admin/teachers/:id/reset-password
func (h *Handler) ResetTeacherPassword(c *fiber.Ctx) error {
	tid, err := strconv.Atoi(c.Params("id"))
	if err != nil || tid == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid teacher id")
	}

	tempPassword := randPassword()
	hashed, err := bcrypt.GenerateFromPassword([]byte(tempPassword), 12)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to hash password")
	}

	result := h.db.Model(&models.Teacher{}).
		Where("id = ? AND role = ?", tid, models.RoleTeacher).
		Updates(map[string]interface{}{
			"hashed_password":      string(hashed),
			"must_change_password": true,
		})
	if result.Error != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to reset password")
	}
	if result.RowsAffected == 0 {
		return fiber.NewError(fiber.StatusNotFound, "teacher not found")
	}
	return c.JSON(fiber.Map{"temp_password": tempPassword})
}

// SetTeacherActive activates or deactivates a teacher account.
// PATCH /api/admin/teachers/:id/active
func (h *Handler) SetTeacherActive(c *fiber.Ctx) error {
	tid, err := strconv.Atoi(c.Params("id"))
	if err != nil || tid == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid teacher id")
	}
	var req struct {
		Active bool `json:"active"`
	}
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	result := h.db.Model(&models.Teacher{}).
		Where("id = ? AND role = ?", tid, models.RoleTeacher).
		Update("is_active", req.Active)
	if result.Error != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to update status")
	}
	if result.RowsAffected == 0 {
		return fiber.NewError(fiber.StatusNotFound, "teacher not found")
	}
	return c.JSON(fiber.Map{"active": req.Active})
}

// DeleteTeacher permanently removes a teacher account.
// DELETE /api/admin/teachers/:id
func (h *Handler) DeleteTeacher(c *fiber.Ctx) error {
	tid, err := strconv.Atoi(c.Params("id"))
	if err != nil || tid == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid teacher id")
	}

	result := h.db.Where("id = ? AND role = ?", tid, models.RoleTeacher).
		Delete(&models.Teacher{})
	if result.Error != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to delete teacher")
	}
	if result.RowsAffected == 0 {
		return fiber.NewError(fiber.StatusNotFound, "teacher not found")
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// GetTeacherExams returns all exams created by a specific teacher.
// GET /api/admin/teachers/:id/exams
func (h *Handler) GetTeacherExams(c *fiber.Ctx) error {
	tid, err := strconv.Atoi(c.Params("id"))
	if err != nil || tid == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid teacher id")
	}

	var exams []models.Exam
	if err := h.db.Where("teacher_id = ?", tid).
		Order("created_at DESC").Find(&exams).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to fetch exams")
	}
	return c.JSON(exams)
}
