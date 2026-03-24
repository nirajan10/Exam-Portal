package handlers

import (
	"fmt"
	"math"
	"time"

	"github.com/exam-platform/backend/middleware"
	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// Register is disabled — teacher accounts are created by a superadmin via
// POST /api/admin/create-teacher.
func (h *Handler) Register(c *fiber.Ctx) error {
	return fiber.NewError(fiber.StatusGone,
		"Self-registration is disabled. Contact your administrator to create an account.")
}

func (h *Handler) Login(c *fiber.Ctx) error {
	ip := c.IP()

	// Check if this IP is currently locked out.
	if remaining := h.loginLimiter.check(ip); remaining > 0 {
		mins := int(math.Ceil(remaining.Minutes()))
		c.Set("Retry-After", fmt.Sprintf("%d", int(math.Ceil(remaining.Seconds()))))
		return fiber.NewError(fiber.StatusTooManyRequests,
			fmt.Sprintf("too many failed attempts — try again in %d minute(s)", mins))
	}

	var req loginRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	var teacher models.Teacher
	if err := h.db.Where("email = ?", req.Email).First(&teacher).Error; err != nil {
		// Uniform message prevents email enumeration.
		h.loginLimiter.recordFailure(ip)
		return fiber.NewError(fiber.StatusUnauthorized, "invalid credentials")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(teacher.HashedPassword), []byte(req.Password)); err != nil {
		h.loginLimiter.recordFailure(ip)
		return fiber.NewError(fiber.StatusUnauthorized, "invalid credentials")
	}

	if !teacher.IsActive {
		return fiber.NewError(fiber.StatusForbidden, "account is deactivated — contact your administrator")
	}

	accessToken, err := h.issueAccessToken(teacher)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to issue token")
	}

	h.loginLimiter.recordSuccess(ip)
	return c.JSON(fiber.Map{"access_token": accessToken, "teacher": teacher})
}

// UpdatePassword lets a logged-in teacher set a new password and clears the
// must_change_password flag. Used by the forced-change flow on first login.
// POST /api/auth/update-password
func (h *Handler) UpdatePassword(c *fiber.Ctx) error {
	tid, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, "unauthorized")
	}

	var req struct {
		NewPassword string `json:"new_password"`
	}
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if len(req.NewPassword) < 8 {
		return fiber.NewError(fiber.StatusBadRequest, "password must be at least 8 characters")
	}

	hashed, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), 12)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to hash password")
	}

	if err := h.db.Model(&models.Teacher{}).Where("id = ?", tid).
		Updates(map[string]interface{}{
			"hashed_password":      string(hashed),
			"must_change_password": false,
		}).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to update password")
	}

	return c.JSON(fiber.Map{"message": "password updated successfully"})
}

// issueAccessToken signs a JWT that embeds the teacher's ID and role so that
// middleware can authorise requests without a database lookup.
func (h *Handler) issueAccessToken(teacher models.Teacher) (string, error) {
	claims := jwt.MapClaims{
		"sub":  teacher.ID,
		"role": string(teacher.Role),
		"exp":  time.Now().Add(24 * time.Hour).Unix(),
		"iat":  time.Now().Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(h.cfg.JWTSecret))
}
