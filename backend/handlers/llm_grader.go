package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/exam-platform/backend/middleware"
	"github.com/exam-platform/backend/models"
	"github.com/exam-platform/backend/runner"
	"github.com/gofiber/fiber/v2"
)

// ── LLM service request / response types ────────────────────────────────────

type llmExecutionResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
	TimedOut bool   `json:"timed_out"`
}

type llmGradeRequest struct {
	QuestionContent string              `json:"question_content"`
	QuestionType    string              `json:"question_type"`
	MaxPoints       int                 `json:"max_points"`
	StudentAnswer   string              `json:"student_answer"`
	Language        string              `json:"language"`
	ExecutionResult *llmExecutionResult `json:"execution_result,omitempty"`
}

type llmGradeResponse struct {
	Score    float64 `json:"score"`
	Feedback string  `json:"feedback"`
}

// Shared HTTP client with generous timeout for LLM inference.
var llmHTTPClient = &http.Client{Timeout: 120 * time.Second}

// ── Health check ────────────────────────────────────────────────────────────

// GetLLMHealth checks if the local LLM service is reachable and model is loaded.
// GET /api/llm/health
func (h *Handler) GetLLMHealth(c *fiber.Ctx) error {
	url := h.cfg.LLMServiceURL + "/health"
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return c.JSON(fiber.Map{"status": "offline", "error": err.Error()})
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return c.JSON(fiber.Map{"status": "unhealthy", "http_status": resp.StatusCode})
	}
	return c.JSON(fiber.Map{"status": "online"})
}

// ── Single submission auto-grade (synchronous) ─────────────────────────────

// AutoGradeSubmission sends all ungraded theory/code answers of a submission
// to the local LLM service for grading.
// POST /api/submissions/:id/auto-grade
func (h *Handler) AutoGradeSubmission(c *fiber.Ctx) error {
	if !h.isLLMEnabled() {
		return fiber.NewError(fiber.StatusForbidden, "AI auto-grading is disabled by the administrator")
	}

	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	submissionID, _ := strconv.Atoi(c.Params("id"))
	var submission models.Submission
	if err := h.db.Preload("Answers").First(&submission, submissionID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "submission not found")
	}

	var exam models.Exam
	if err := h.db.Preload("QuestionSets.Questions").
		Where("id = ? AND teacher_id = ?", submission.ExamID, teacherID).
		First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusForbidden, "access denied")
	}

	qMap := make(map[uint]models.Question)
	for _, qs := range exam.QuestionSets {
		for _, q := range qs.Questions {
			qMap[q.ID] = q
		}
	}

	graded := 0
	failed := 0
	for i, ans := range submission.Answers {
		q, ok := qMap[ans.QuestionID]
		if !ok || (q.Type != models.QuestionTypeTheory && q.Type != models.QuestionTypeCode) {
			continue
		}
		if ans.Answer == "" || ans.Answer == "[]" {
			continue
		}

		// Throttle: wait between LLM calls so the service isn't overwhelmed.
		if i > 0 {
			time.Sleep(500 * time.Millisecond)
		}

		result, err := h.callLLMGradeWithRetry(q, ans)
		if err != nil {
			log.Printf("LLM grade error for answer %d: %v", ans.ID, err)
			failed++
			continue
		}

		h.db.Model(&models.SubmissionAnswer{}).
			Where("id = ?", ans.ID).
			Updates(map[string]interface{}{
				"score":    result.Score,
				"feedback": result.Feedback,
			})
		graded++
	}

	h.recalcSubmission(submissionID)

	var updated models.Submission
	h.db.Preload("Answers").First(&updated, submissionID)
	return c.JSON(fiber.Map{
		"submission": updated,
		"graded":     graded,
		"failed":     failed,
	})
}

// ── Bulk auto-grade all pending submissions (async via Celery) ──────────────

// batchGradeItem matches the LLM service's BatchGradeItem schema.
type batchGradeItem struct {
	ID              string              `json:"id"`
	QuestionContent string              `json:"question_content"`
	QuestionType    string              `json:"question_type"`
	MaxPoints       int                 `json:"max_points"`
	StudentAnswer   string              `json:"student_answer"`
	Language        string              `json:"language"`
	ExecutionResult *llmExecutionResult `json:"execution_result,omitempty"`
}

// AutoGradeAllSubmissions grades all pending theory/code answers for an exam.
// Submits all tasks to Celery via the LLM service's batch endpoint, then polls
// for results. This avoids overloading the LLM — the queue processes one at a time.
// POST /api/exams/:id/auto-grade-all
func (h *Handler) AutoGradeAllSubmissions(c *fiber.Ctx) error {
	if !h.isLLMEnabled() {
		return fiber.NewError(fiber.StatusForbidden, "AI auto-grading is disabled by the administrator")
	}

	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	examID, _ := strconv.Atoi(c.Params("id"))
	var exam models.Exam
	if err := h.db.Preload("QuestionSets.Questions").
		Where("id = ? AND teacher_id = ?", examID, teacherID).
		First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusForbidden, "exam not found or access denied")
	}

	qMap := make(map[uint]models.Question)
	for _, qs := range exam.QuestionSets {
		for _, q := range qs.Questions {
			qMap[q.ID] = q
		}
	}

	var submissions []models.Submission
	h.db.Preload("Answers").Where("exam_id = ?", examID).Find(&submissions)

	// Collect all gradable answers and pre-execute code questions.
	type gradableItem struct {
		answerID     uint
		submissionID uint
		batchItem    batchGradeItem
	}
	var items []gradableItem

	for _, sub := range submissions {
		for _, ans := range sub.Answers {
			q, ok := qMap[ans.QuestionID]
			if !ok || (q.Type != models.QuestionTypeTheory && q.Type != models.QuestionTypeCode) {
				continue
			}
			if ans.Answer == "" || ans.Answer == "[]" {
				continue
			}

			item := batchGradeItem{
				ID:              fmt.Sprintf("%d", ans.ID),
				QuestionContent: q.Content,
				QuestionType:    string(q.Type),
				MaxPoints:       q.Points,
				StudentAnswer:   ans.Answer,
				Language:         q.Language,
			}

			// Pre-execute code questions in sandbox.
			if q.Type == models.QuestionTypeCode && h.runner != nil && q.Language != "" {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				execResult, execErr := h.runner.Run(ctx, runner.Language(q.Language), ans.Answer, "")
				cancel()
				if execErr != nil {
					log.Printf("Code execution failed for answer %d: %v", ans.ID, execErr)
				} else {
					item.ExecutionResult = &llmExecutionResult{
						Stdout:   execResult.Stdout,
						Stderr:   execResult.Stderr,
						ExitCode: execResult.ExitCode,
						TimedOut: execResult.TimedOut,
					}
				}
			}

			items = append(items, gradableItem{
				answerID:     ans.ID,
				submissionID: sub.ID,
				batchItem:    item,
			})
		}
	}

	if len(items) == 0 {
		return c.JSON(fiber.Map{
			"submissions_processed": 0,
			"answers_graded":        0,
			"answers_failed":        0,
			"message":               "No gradable answers found",
		})
	}

	// Submit batch to the LLM service's Celery queue.
	batchItems := make([]batchGradeItem, len(items))
	for i, it := range items {
		batchItems[i] = it.batchItem
	}

	batchBody, _ := json.Marshal(map[string]interface{}{"items": batchItems})
	batchResp, err := llmHTTPClient.Post(
		h.cfg.LLMServiceURL+"/grade/batch",
		"application/json",
		bytes.NewReader(batchBody),
	)
	if err != nil {
		return fiber.NewError(fiber.StatusBadGateway, fmt.Sprintf("LLM service unreachable: %v", err))
	}
	defer batchResp.Body.Close()

	if batchResp.StatusCode != 200 {
		body, _ := io.ReadAll(batchResp.Body)
		return fiber.NewError(fiber.StatusBadGateway,
			fmt.Sprintf("LLM batch submit failed (%d): %s", batchResp.StatusCode, string(body)))
	}

	var batchResult struct {
		Tasks map[string]string `json:"tasks"` // caller_id → celery_task_id
		Total int               `json:"total"`
	}
	json.NewDecoder(batchResp.Body).Decode(&batchResult)

	// Build mapping: celery_task_id → answer info.
	type pendingTask struct {
		answerID     uint
		submissionID uint
		maxPoints    int
	}
	pending := make(map[string]pendingTask)
	for _, it := range items {
		celeryID, ok := batchResult.Tasks[it.batchItem.ID]
		if !ok {
			continue
		}
		pending[celeryID] = pendingTask{
			answerID:     it.answerID,
			submissionID: it.submissionID,
			maxPoints:    it.batchItem.MaxPoints,
		}
	}

	// Poll for results until all done or timeout.
	totalGraded := 0
	totalFailed := 0
	touchedSubmissions := make(map[uint]bool)
	deadline := time.Now().Add(30 * time.Minute)

	for len(pending) > 0 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)

		// Collect all pending task IDs.
		taskIDs := make([]string, 0, len(pending))
		for tid := range pending {
			taskIDs = append(taskIDs, tid)
		}

		statusBody, _ := json.Marshal(map[string]interface{}{"task_ids": taskIDs})
		statusResp, err := llmHTTPClient.Post(
			h.cfg.LLMServiceURL+"/grade/status",
			"application/json",
			bytes.NewReader(statusBody),
		)
		if err != nil {
			log.Printf("Failed to poll task status: %v", err)
			continue
		}

		var statusResult struct {
			Tasks map[string]struct {
				State  string           `json:"state"`
				Result *llmGradeResponse `json:"result,omitempty"`
				Error  string           `json:"error,omitempty"`
			} `json:"tasks"`
		}
		json.NewDecoder(statusResp.Body).Decode(&statusResult)
		statusResp.Body.Close()

		for tid, status := range statusResult.Tasks {
			pt, ok := pending[tid]
			if !ok {
				continue
			}

			switch status.State {
			case "SUCCESS":
				if status.Result != nil {
					score := status.Result.Score
					if score < 0 {
						score = 0
					}
					if score > float64(pt.maxPoints) {
						score = float64(pt.maxPoints)
					}
					h.db.Model(&models.SubmissionAnswer{}).
						Where("id = ?", pt.answerID).
						Updates(map[string]interface{}{
							"score":    score,
							"feedback": status.Result.Feedback,
						})
					totalGraded++
					touchedSubmissions[pt.submissionID] = true
				}
				delete(pending, tid)

			case "FAILURE":
				log.Printf("Celery task %s failed for answer %d: %s", tid, pt.answerID, status.Error)
				totalFailed++
				delete(pending, tid)
			}
			// PENDING / STARTED → keep polling
		}
	}

	// Count anything still pending as failed (timeout).
	totalFailed += len(pending)

	// Recalculate totals for all affected submissions.
	for subID := range touchedSubmissions {
		h.recalcSubmission(int(subID))
	}

	return c.JSON(fiber.Map{
		"submissions_processed": len(touchedSubmissions),
		"answers_graded":        totalGraded,
		"answers_failed":        totalFailed,
		"message": fmt.Sprintf("Graded %d answers across %d submissions (%d failed)",
			totalGraded, len(touchedSubmissions), totalFailed),
	})
}

// ── Internal helpers ────────────────────────────────────────────────────────

// callLLMGradeWithRetry calls the LLM service with one retry on failure.
func (h *Handler) callLLMGradeWithRetry(q models.Question, ans models.SubmissionAnswer) (*llmGradeResponse, error) {
	result, err := h.callLLMGrade(q, ans)
	if err != nil {
		// Wait and retry once.
		log.Printf("LLM call failed for answer %d, retrying in 2s: %v", ans.ID, err)
		time.Sleep(2 * time.Second)
		result, err = h.callLLMGrade(q, ans)
	}
	return result, err
}

// callLLMGrade calls the local LLM service to grade a single answer.
// For code questions, it first executes the code in a sandbox.
func (h *Handler) callLLMGrade(q models.Question, ans models.SubmissionAnswer) (*llmGradeResponse, error) {
	req := llmGradeRequest{
		QuestionContent: q.Content,
		QuestionType:    string(q.Type),
		MaxPoints:       q.Points,
		StudentAnswer:   ans.Answer,
		Language:        q.Language,
	}

	// For code questions, execute in sandbox first and pass results to LLM.
	if q.Type == models.QuestionTypeCode && h.runner != nil && q.Language != "" {
		// Use a detached context with its own timeout so it doesn't die with the HTTP request.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		execResult, err := h.runner.Run(ctx, runner.Language(q.Language), ans.Answer, "")
		if err != nil {
			log.Printf("Code execution failed for answer %d: %v", ans.ID, err)
		} else {
			req.ExecutionResult = &llmExecutionResult{
				Stdout:   execResult.Stdout,
				Stderr:   execResult.Stderr,
				ExitCode: execResult.ExitCode,
				TimedOut: execResult.TimedOut,
			}
		}
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	url := h.cfg.LLMServiceURL + "/grade"
	httpResp, err := llmHTTPClient.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("LLM service unreachable: %w", err)
	}
	defer httpResp.Body.Close()

	respBody, _ := io.ReadAll(httpResp.Body)

	if httpResp.StatusCode != 200 {
		return nil, fmt.Errorf("LLM service returned %d: %s", httpResp.StatusCode, string(respBody))
	}

	var result llmGradeResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("parse LLM response: %w", err)
	}

	// Clamp score to [0, maxPoints].
	if result.Score < 0 {
		result.Score = 0
	}
	if result.Score > float64(q.Points) {
		result.Score = float64(q.Points)
	}

	return &result, nil
}

// recalcSubmission recalculates a submission's total score and status.
func (h *Handler) recalcSubmission(submissionID int) {
	var answers []models.SubmissionAnswer
	h.db.Where("submission_id = ?", submissionID).Find(&answers)

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

	var existing models.Submission
	h.db.Select("graded_by").First(&existing, submissionID)
	gradedBy := models.GradedByAI
	if existing.GradedBy == models.GradedByHuman {
		gradedBy = models.GradedByBoth
	}

	h.db.Model(&models.Submission{}).Where("id = ?", submissionID).
		Updates(map[string]interface{}{
			"total_score": total,
			"status":      string(status),
			"graded_by":   string(gradedBy),
		})
}
