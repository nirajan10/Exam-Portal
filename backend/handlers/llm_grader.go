package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	appcrypto "github.com/exam-platform/backend/crypto"
	"github.com/exam-platform/backend/middleware"
	"github.com/exam-platform/backend/models"
	"github.com/exam-platform/backend/runner"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

// ── Request / response types ──────────────────────────────────────────────────

type llmSettingsRequest struct {
	GeminiModel string `json:"gemini_model"`
	// APIKey is the plain-text Gemini API key sent from the browser.
	// If empty, the existing stored key is preserved.
	APIKey string `json:"api_key"`
}

type llmSettingsResponse struct {
	GeminiModel string `json:"gemini_model"`
	APIKeySet   bool   `json:"api_key_set"`
}

// ── Settings handlers ─────────────────────────────────────────────────────────

// GetLLMSettings returns the teacher's current Gemini LLM config (key presence only).
// GET /api/me/llm-settings
func (h *Handler) GetLLMSettings(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	var teacher models.Teacher
	if err := h.db.First(&teacher, teacherID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "teacher not found")
	}

	return c.JSON(llmSettingsResponse{
		GeminiModel: teacher.GeminiModel,
		APIKeySet:   teacher.GeminiAPIKey != "",
	})
}

// SaveLLMSettings persists the teacher's Gemini LLM config.
// The API key is AES-256-GCM encrypted before storage.
// PUT /api/me/llm-settings
func (h *Handler) SaveLLMSettings(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	var req llmSettingsRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}

	model := strings.TrimSpace(req.GeminiModel)
	if model == "" {
		model = "gemini-2.5-flash"
	}

	updates := map[string]interface{}{
		"gemini_model": model,
	}

	if req.APIKey != "" {
		key := appcrypto.DeriveKey(h.cfg.JWTSecret)
		encrypted, err := appcrypto.Encrypt(strings.TrimSpace(req.APIKey), key)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "encryption failed")
		}
		updates["gemini_api_key"] = encrypted
	}

	var teacher models.Teacher
	if err := h.db.First(&teacher, teacherID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "teacher not found")
	}
	if err := h.db.Model(&teacher).Updates(updates).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to save LLM settings")
	}

	return c.JSON(llmSettingsResponse{
		GeminiModel: model,
		APIKeySet:   teacher.GeminiAPIKey != "" || req.APIKey != "",
	})
}

// ── Auto-grade handlers ───────────────────────────────────────────────────────

type autoGradeResult struct {
	AnswerID uint    `json:"answer_id"`
	Score    float64 `json:"score"`
	Feedback string  `json:"feedback"`
}

// AutoGradeSubmission uses the teacher's Gemini API key to grade all unscored
// theory/code answers in a single submission.
// POST /api/submissions/:id/auto-grade
func (h *Handler) AutoGradeSubmission(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	submissionID, _ := strconv.Atoi(c.Params("id"))
	if submissionID == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid submission id")
	}

	var submission models.Submission
	if err := h.db.Preload("Answers").First(&submission, submissionID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "submission not found")
	}

	// Verify ownership.
	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", submission.ExamID, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusForbidden, "access denied")
	}

	// Load teacher + decrypt API key.
	apiKey, model, err := h.loadGeminiCredentials(teacherID)
	if err != nil {
		return err
	}

	// Load questions for this submission.
	qMap, _ := h.loadQuestionsForSubmission(submission)

	// Grade all theory/code answers (including already-graded ones for re-grading).
	var results []autoGradeResult
	var errors []string
	firstCall := true
	for _, ans := range submission.Answers {
		q, ok := qMap[ans.QuestionID]
		if !ok {
			continue
		}
		if q.Type != models.QuestionTypeTheory && q.Type != models.QuestionTypeCode {
			continue
		}
		if ans.Answer == "" || ans.Answer == "[]" {
			continue // empty — already scored 0 at submit time
		}

		// Small delay between calls to avoid rate limits.
		if !firstCall {
			time.Sleep(1 * time.Second)
		}
		firstCall = false

		score, feedback, gradeErr := h.gradeWithLLM(c, apiKey, model, q, ans)
		if gradeErr != nil {
			log.Printf("llm-grader: failed to grade answer %d: %v", ans.ID, gradeErr)
			errors = append(errors, fmt.Sprintf("Q%d: %v", ans.QuestionID, gradeErr))
			// Skip this answer — leave it unscored so teacher can retry or grade manually
			continue
		}
		log.Printf("llm-grader: answer %d scored %.1f/%d", ans.ID, score, q.Points)
		results = append(results, autoGradeResult{
			AnswerID: ans.ID,
			Score:    score,
			Feedback: feedback,
		})
	}

	// Persist grades using the same logic as manual GradeSubmission.
	if len(results) > 0 {
		if txErr := h.persistAutoGrades(submission, results); txErr != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "failed to persist grades: "+txErr.Error())
		}
	}

	// If all answers failed to grade, return an error.
	if len(results) == 0 && len(errors) > 0 {
		return fiber.NewError(fiber.StatusBadGateway, "AI grading failed: "+strings.Join(errors, "; "))
	}

	// Return updated submission.
	h.db.Preload("Answers").First(&submission, submissionID)
	return c.JSON(submission)
}

// AutoGradeAllSubmissions grades all pending submissions for an exam.
// POST /api/exams/:id/auto-grade-all
func (h *Handler) AutoGradeAllSubmissions(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	examID, _ := strconv.Atoi(c.Params("id"))
	if examID == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid exam id")
	}

	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", examID, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}

	apiKey, model, err := h.loadGeminiCredentials(teacherID)
	if err != nil {
		return err
	}

	// Load all pending submissions.
	var submissions []models.Submission
	h.db.Preload("Answers").
		Where("exam_id = ? AND status = ?", examID, models.SubmissionStatusPendingGrading).
		Find(&submissions)

	if len(submissions) == 0 {
		return c.JSON(fiber.Map{"graded": 0, "failed": 0, "message": "no pending submissions to grade"})
	}

	// Load all questions for these submissions.
	questions := h.loadQuestionsForExam(uint(examID), submissions)
	qMap := make(map[uint]models.Question, len(questions))
	for _, q := range questions {
		qMap[q.ID] = q
	}

	graded := 0
	failed := 0

	firstCall := true
	for _, sub := range submissions {
		var results []autoGradeResult

		for _, ans := range sub.Answers {
			if ans.Score != nil {
				continue
			}
			q, ok := qMap[ans.QuestionID]
			if !ok {
				continue
			}
			if q.Type != models.QuestionTypeTheory && q.Type != models.QuestionTypeCode {
				continue
			}
			if ans.Answer == "" || ans.Answer == "[]" {
				continue
			}

			// Small delay between calls to avoid rate limits.
			if !firstCall {
				time.Sleep(1 * time.Second)
			}
			firstCall = false

			score, feedback, gradeErr := h.gradeWithLLM(c, apiKey, model, q, ans)
			if gradeErr != nil {
				log.Printf("llm-grader: failed to grade answer %d (submission %d): %v", ans.ID, sub.ID, gradeErr)
				// Skip — leave unscored for manual grading
				continue
			}
			log.Printf("llm-grader: answer %d (submission %d) scored %.1f/%d", ans.ID, sub.ID, score, q.Points)
			results = append(results, autoGradeResult{
				AnswerID: ans.ID,
				Score:    score,
				Feedback: feedback,
			})
		}

		if len(results) > 0 {
			if txErr := h.persistAutoGrades(sub, results); txErr != nil {
				log.Printf("llm-grader: failed to persist grades for submission %d: %v", sub.ID, txErr)
				failed++
				continue
			}
			graded++
		}
	}

	return c.JSON(fiber.Map{
		"graded":  graded,
		"failed":  failed,
		"message": fmt.Sprintf("%d submission(s) graded, %d failed", graded, failed),
	})
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// loadGeminiCredentials fetches the teacher's Gemini API key and model.
func (h *Handler) loadGeminiCredentials(teacherID uint) (apiKey, model string, ferr error) {
	var teacher models.Teacher
	if err := h.db.First(&teacher, teacherID).Error; err != nil {
		ferr = fiber.NewError(fiber.StatusInternalServerError, "could not load teacher record")
		return
	}
	if teacher.GeminiAPIKey == "" {
		ferr = fiber.NewError(fiber.StatusBadRequest,
			"Gemini API key not configured — set up your AI Grading settings in Profile → AI Grading")
		return
	}

	key := appcrypto.DeriveKey(h.cfg.JWTSecret)
	decrypted, err := appcrypto.Decrypt(teacher.GeminiAPIKey, key)
	if err != nil {
		ferr = fiber.NewError(fiber.StatusInternalServerError, "failed to decrypt Gemini API key")
		return
	}
	apiKey = decrypted
	model = teacher.GeminiModel
	if model == "" {
		model = "gemini-2.5-flash"
	}
	return
}

// gradeWithLLM calls the Gemini API to grade a single answer.
// For code questions, it first runs the code and includes the output in the prompt.
func (h *Handler) gradeWithLLM(
	c *fiber.Ctx,
	apiKey, model string,
	q models.Question,
	ans models.SubmissionAnswer,
) (score float64, feedback string, err error) {
	var prompt string

	if q.Type == models.QuestionTypeCode {
		prompt, err = h.buildCodeGradingPrompt(c, q, ans)
	} else {
		prompt = buildTheoryGradingPrompt(q, ans)
	}
	if err != nil {
		return 0, "", err
	}

	response, err := callGemini(apiKey, model, prompt)
	if err != nil {
		return 0, "", err
	}

	log.Printf("llm-grader: raw response for answer %d: %s", ans.ID, truncate(response, 300))
	return parseGradingResponse(response, q.Points)
}

// buildCodeGradingPrompt runs the student's code and builds a prompt including
// the execution result for the LLM to evaluate.
func (h *Handler) buildCodeGradingPrompt(
	c *fiber.Ctx,
	q models.Question,
	ans models.SubmissionAnswer,
) (string, error) {
	var execResult *runner.RunResult
	var execErr error

	// Try to run the code if runner is available and language is set.
	if h.runner != nil && q.Language != "" {
		execResult, execErr = h.runner.Run(c.Context(), runner.Language(q.Language), ans.Answer, "")
	}

	var sb strings.Builder
	sb.WriteString("You are an exam grader. Grade the following coding question.\n\n")
	sb.WriteString("## Question\n")
	sb.WriteString(q.Content)
	sb.WriteString("\n\n")
	sb.WriteString(fmt.Sprintf("## Maximum Marks: %d\n\n", q.Points))
	sb.WriteString(fmt.Sprintf("## Programming Language: %s\n\n", q.Language))
	sb.WriteString("## Student's Code\n```\n")
	sb.WriteString(ans.Answer)
	sb.WriteString("\n```\n\n")

	if execErr != nil {
		sb.WriteString("## Code Execution: FAILED to run\n")
		sb.WriteString(fmt.Sprintf("Error: %s\n\n", execErr.Error()))
	} else if execResult != nil {
		sb.WriteString("## Code Execution Result\n")
		sb.WriteString(fmt.Sprintf("- Exit Code: %d\n", execResult.ExitCode))
		sb.WriteString(fmt.Sprintf("- Timed Out: %v\n", execResult.TimedOut))
		if execResult.Stdout != "" {
			sb.WriteString(fmt.Sprintf("- Stdout:\n```\n%s\n```\n", truncate(execResult.Stdout, 2000)))
		}
		if execResult.Stderr != "" {
			sb.WriteString(fmt.Sprintf("- Stderr:\n```\n%s\n```\n", truncate(execResult.Stderr, 1000)))
		}
		sb.WriteString("\n")
	}

	sb.WriteString(`## Grading Instructions
1. Check if the code compiles/runs correctly.
2. Check if the code actually solves the problem using a proper algorithm (not just hardcoded/printed output).
3. Evaluate the logic, correctness, and code quality.
4. If the code simply prints the expected answer without computing it, give very low marks and note "bypass detected".
5. Award partial marks for partially correct solutions.

## Response Format
You MUST respond with ONLY a JSON object in this exact format (no markdown, no extra text):
{"score": <number between 0 and ` + strconv.Itoa(q.Points) + `>, "feedback": "<brief feedback>"}`)

	return sb.String(), nil
}

// buildTheoryGradingPrompt builds a prompt for grading theory questions.
func buildTheoryGradingPrompt(q models.Question, ans models.SubmissionAnswer) string {
	var sb strings.Builder
	sb.WriteString("You are an exam grader. Grade the following theory question.\n\n")
	sb.WriteString("## Question\n")
	sb.WriteString(q.Content)
	sb.WriteString("\n\n")
	sb.WriteString(fmt.Sprintf("## Maximum Marks: %d\n\n", q.Points))
	sb.WriteString("## Student's Answer\n")
	sb.WriteString(ans.Answer)
	sb.WriteString("\n\n")

	sb.WriteString(`## Grading Instructions
1. Evaluate correctness, completeness, and clarity of the answer.
2. Award partial marks for partially correct answers.
3. Be fair but strict — the answer should demonstrate understanding.

## Response Format
You MUST respond with ONLY a JSON object in this exact format (no markdown, no extra text):
{"score": <number between 0 and ` + strconv.Itoa(q.Points) + `>, "feedback": "<brief feedback>"}`)

	return sb.String()
}

// callGemini sends a prompt to the Gemini API and returns the text response.
// Retries up to 3 times on 429 (rate limit) errors with exponential backoff.
func callGemini(apiKey, model, prompt string) (string, error) {
	url := fmt.Sprintf(
		"https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s",
		model, apiKey,
	)

	body := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]string{
					{"text": prompt},
				},
			},
		},
		"generationConfig": map[string]interface{}{
			"temperature":     0.1,
			"maxOutputTokens": 2048,
		},
	}

	jsonBody, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	client := &http.Client{Timeout: 60 * time.Second}

	const maxRetries = 3
	backoff := 2 * time.Second

	var respBody []byte
	var statusCode int

	for attempt := 0; attempt <= maxRetries; attempt++ {
		resp, postErr := client.Post(url, "application/json", bytes.NewReader(jsonBody))
		if postErr != nil {
			return "", fmt.Errorf("Gemini API request failed: %w", postErr)
		}

		respBody, err = io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return "", fmt.Errorf("failed to read response: %w", err)
		}
		statusCode = resp.StatusCode

		if statusCode == 429 && attempt < maxRetries {
			log.Printf("llm-grader: rate limited (429), retrying in %v (attempt %d/%d)", backoff, attempt+1, maxRetries)
			time.Sleep(backoff)
			backoff *= 2
			continue
		}
		break
	}

	if statusCode != 200 {
		return "", fmt.Errorf("Gemini API error (status %d): %s", statusCode, truncate(string(respBody), 500))
	}

	// Parse Gemini response.
	var geminiResp struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(respBody, &geminiResp); err != nil {
		return "", fmt.Errorf("failed to parse Gemini response: %w", err)
	}
	if len(geminiResp.Candidates) == 0 || len(geminiResp.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("empty response from Gemini")
	}

	return geminiResp.Candidates[0].Content.Parts[0].Text, nil
}

// jsonObjectRe matches the first JSON object in a string.
var jsonObjectRe = regexp.MustCompile(`\{[^{}]*"score"\s*:\s*[\d.]+[^{}]*"feedback"\s*:\s*"[^"]*"[^{}]*\}`)

// parseGradingResponse extracts score and feedback from the LLM's JSON response.
func parseGradingResponse(response string, maxPoints int) (float64, string, error) {
	// Strip markdown code fences if the LLM wrapped its response.
	cleaned := strings.TrimSpace(response)
	cleaned = strings.TrimPrefix(cleaned, "```json")
	cleaned = strings.TrimPrefix(cleaned, "```")
	cleaned = strings.TrimSuffix(cleaned, "```")
	cleaned = strings.TrimSpace(cleaned)

	var result struct {
		Score    float64 `json:"score"`
		Feedback string  `json:"feedback"`
	}

	// Try direct parse first.
	if err := json.Unmarshal([]byte(cleaned), &result); err != nil {
		// Fallback: extract JSON object from potentially noisy LLM output.
		if match := jsonObjectRe.FindString(cleaned); match != "" {
			if err2 := json.Unmarshal([]byte(match), &result); err2 != nil {
				return 0, "", fmt.Errorf("failed to parse LLM response: %w (raw: %s)", err2, truncate(cleaned, 200))
			}
		} else {
			return 0, "", fmt.Errorf("failed to parse LLM response: %w (raw: %s)", err, truncate(cleaned, 200))
		}
	}

	// Clamp score to valid range.
	result.Score = math.Max(0, math.Min(result.Score, float64(maxPoints)))
	// Round to 1 decimal place.
	result.Score = math.Round(result.Score*10) / 10

	log.Printf("llm-grader: parsed score=%.1f feedback=%q", result.Score, truncate(result.Feedback, 100))
	return result.Score, result.Feedback, nil
}

// persistAutoGrades saves the LLM-generated grades and recalculates totals.
// Uses the same update pattern as the manual GradeSubmission handler.
func (h *Handler) persistAutoGrades(submission models.Submission, results []autoGradeResult) error {
	return h.db.Transaction(func(tx *gorm.DB) error {
		for _, r := range results {
			score := r.Score
			feedback := "[AI] " + r.Feedback
			res := tx.Model(&models.SubmissionAnswer{}).
				Where("id = ? AND submission_id = ?", r.AnswerID, submission.ID).
				Updates(map[string]interface{}{
					"score":    score,
					"feedback": feedback,
				})
			if res.Error != nil {
				return res.Error
			}
			log.Printf("llm-grader: persisted answer %d: score=%.1f rows_affected=%d", r.AnswerID, score, res.RowsAffected)
		}

		// Recalculate total from all answers (same logic as GradeSubmission).
		var answers []models.SubmissionAnswer
		if err := tx.Where("submission_id = ?", submission.ID).Find(&answers).Error; err != nil {
			return err
		}
		total := 0.0
		allGraded := true
		for _, a := range answers {
			if a.Score != nil {
				total += *a.Score
			} else {
				allGraded = false
			}
		}
		status := models.SubmissionStatusPendingGrading
		if allGraded {
			status = models.SubmissionStatusGraded
		}

		log.Printf("llm-grader: submission %d total=%.1f allGraded=%v status=%s", submission.ID, total, allGraded, status)

		// Use the loaded submission model (with PK set) — matches GradeSubmission pattern.
		return tx.Model(&submission).Updates(map[string]interface{}{
			"total_score": total,
			"status":      string(status),
		}).Error
	})
}

// truncate shortens a string to maxLen characters.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "…"
}
