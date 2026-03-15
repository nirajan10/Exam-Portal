package handlers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
)

// JoinResponse is returned to the student after joining an exam.
type JoinResponse struct {
	SessionID     string `json:"session_id"`
	AssignedSetID uint   `json:"assigned_set_id"`
}

// JoinExam assigns a deterministic session ID and question set to a student.
//
// The session ID is computed as HMAC-SHA256(JWT_SECRET, "examId|email")[:4] → hex.
// The set index is the next 4 bytes of the same digest modulo the number of sets.
// Both are fully reproducible from the same inputs, so refreshing the page or
// re-entering the exam always gives the student the same session and the same set.
//
// POST /api/exams/:id/join  — public (no JWT required)
func (h *Handler) JoinExam(c *fiber.Ctx) error {
	examID, _ := strconv.Atoi(c.Params("id"))
	if examID == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid exam id")
	}

	var req struct {
		StudentName  string `json:"student_name"`
		StudentEmail string `json:"student_email"`
	}
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	req.StudentEmail = strings.ToLower(strings.TrimSpace(req.StudentEmail))
	req.StudentName  = strings.TrimSpace(req.StudentName)
	if req.StudentName == "" || req.StudentEmail == "" {
		return fiber.NewError(fiber.StatusBadRequest, "student_name and student_email are required")
	}

	// Verify exam exists and is active.
	var exam models.Exam
	if err := h.db.First(&exam, examID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}
	if !exam.IsActive {
		return fiber.NewError(fiber.StatusForbidden, "this exam is not currently open")
	}

	// Reject if the exam has already concluded (past examEnd).
	if exam.StartedAt != nil {
		bufferDur := time.Duration(exam.BufferDurationMins) * time.Minute
		examDur   := time.Duration(exam.DurationMinutes) * time.Minute
		examEnd   := exam.StartedAt.Add(bufferDur).Add(examDur)
		if time.Now().UTC().After(examEnd) {
			return fiber.NewError(fiber.StatusGone, "This exam has already concluded.")
		}
	}

	// Load question sets sorted by display order then id (stable ordering).
	var sets []models.QuestionSet
	if err := h.db.Where("exam_id = ?", examID).
		Order(`"order" ASC, id ASC`).
		Find(&sets).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load question sets")
	}
	if len(sets) == 0 {
		return fiber.NewError(fiber.StatusConflict, "this exam has no question sets yet")
	}

	// Derive session ID and set assignment from a single HMAC digest.
	// Using the JWT secret as the key means students cannot reverse-engineer
	// which email maps to which set without knowing the server secret.
	mac := hmac.New(sha256.New, []byte(h.cfg.JWTSecret))
	mac.Write([]byte(fmt.Sprintf("%d|%s", examID, req.StudentEmail)))
	digest := mac.Sum(nil)

	// Bytes 0–3 → session ID (8 uppercase hex chars, e.g. "STU-A1B2C3D4")
	sessionID := "STU-" + strings.ToUpper(hex.EncodeToString(digest[:4]))

	// Bytes 4–7 → set index (appears random; deterministic for same input)
	setIndex := int(binary.BigEndian.Uint32(digest[4:8])) % len(sets)

	return c.JSON(JoinResponse{
		SessionID:     sessionID,
		AssignedSetID: sets[setIndex].ID,
	})
}
