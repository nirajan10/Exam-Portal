package handlers

import (
	"strconv"

	"github.com/exam-platform/backend/models"
	"github.com/exam-platform/backend/runner"
	"github.com/gofiber/fiber/v2"
)

type executeRequest struct {
	Language string `json:"language"`
	Code     string `json:"code"`
	// Stdin is optional program input. When non-empty, code is embedded via
	// base64 in the command line so stdin is free for the running program.
	// Only honoured by the teacher endpoint — students never supply stdin.
	Stdin string `json:"stdin"`
}

// Execute runs arbitrary code for an authenticated teacher (sandbox testing).
// POST /api/execute  — JWT-protected
func (h *Handler) Execute(c *fiber.Ctx) error {
	var req executeRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if err := validateExecuteRequest(req); err != nil {
		return err
	}

	// Teachers can supply stdin to test edge cases; no run-count limit enforced.
	result, err := h.runner.Run(c.Context(), runner.Language(req.Language), req.Code, req.Stdin)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "execution failed: "+err.Error())
	}
	return c.JSON(result)
}

// ExecuteForStudent runs code on behalf of a student taking a specific exam.
// The exam must have max_code_runs > 0; otherwise execution is disabled.
// POST /api/exams/:id/execute  — public (no JWT)
func (h *Handler) ExecuteForStudent(c *fiber.Ctx) error {
	examID, _ := strconv.Atoi(c.Params("id"))

	var exam models.Exam
	if err := h.db.First(&exam, examID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}
	if exam.MaxCodeRuns == 0 {
		return fiber.NewError(fiber.StatusForbidden, "code execution is disabled for this exam")
	}

	var req executeRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if err := validateExecuteRequest(req); err != nil {
		return err
	}

	// Pass stdin from student request; if omitted it's empty string (EOF for program).
	result, err := h.runner.Run(c.Context(), runner.Language(req.Language), req.Code, req.Stdin)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "execution failed: "+err.Error())
	}
	return c.JSON(result)
}

func validateExecuteRequest(req executeRequest) error {
	switch req.Language {
	case "c", "cpp", "python":
		// valid
	default:
		return fiber.NewError(fiber.StatusBadRequest, "language must be one of: c, cpp, python")
	}
	if len(req.Code) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "code must not be empty")
	}
	if len(req.Code) > 65536 {
		return fiber.NewError(fiber.StatusBadRequest, "code exceeds 64 KB limit")
	}
	return nil
}
