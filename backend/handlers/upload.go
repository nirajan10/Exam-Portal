package handlers

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"

	"github.com/exam-platform/backend/middleware"
	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

type csvRowError struct {
	Row     int    `json:"row"`
	Message string `json:"message"`
}

type uploadResult struct {
	Inserted int           `json:"inserted"`
	Errors   []csvRowError `json:"errors,omitempty"`
}

// UploadQuestions parses a CSV file and bulk-inserts questions into a question set.
// All rows are validated before any insert; a single invalid row aborts the whole batch.
//
// POST /api/exams/:id/upload-questions?set_id=N  (set_id optional; falls back to first set)
//
// CSV columns (header row required):
//
//	Question Text | Type | Options | Correct Answers | Randomize Options | Marks
//
// Options and Correct Answers are pipe-separated (e.g. "A|B|C" and "A|C").
// Randomize Options accepts: true / false (case-insensitive).
// Marks defaults to 1 when the column is absent, empty, or non-numeric.
func (h *Handler) UploadQuestions(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	examID, _ := strconv.Atoi(c.Params("id"))

	// Verify the teacher owns this exam.
	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", examID, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}

	// Resolve the target question set.
	var qs models.QuestionSet
	setID := c.QueryInt("set_id", 0)
	if setID > 0 {
		if err := h.db.Where("id = ? AND exam_id = ?", setID, examID).First(&qs).Error; err != nil {
			return fiber.NewError(fiber.StatusNotFound, "question set not found")
		}
	} else {
		if err := h.db.Where("exam_id = ?", examID).Order(`"order" asc, id asc`).First(&qs).Error; err != nil {
			return fiber.NewError(fiber.StatusBadRequest,
				"no question sets exist for this exam; create one before uploading")
		}
	}

	// Read the uploaded file.
	fh, err := c.FormFile("file")
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, `multipart field "file" is required`)
	}
	f, err := fh.Open()
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "could not read uploaded file")
	}
	defer f.Close()

	// Parse CSV.
	reader := csv.NewReader(f)
	reader.TrimLeadingSpace = true
	rows, err := reader.ReadAll()
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid CSV format: "+err.Error())
	}
	if len(rows) < 2 {
		return fiber.NewError(fiber.StatusBadRequest,
			"CSV must contain a header row and at least one data row")
	}

	dataRows := rows[1:] // skip header

	// ── Validate ALL rows before inserting anything ───────────────────────────

	var questions []models.Question
	var rowErrors []csvRowError

	for i, row := range dataRows {
		rowNum := i + 2 // 1-based row number, header = row 1

		if len(row) < 5 {
			rowErrors = append(rowErrors, csvRowError{
				Row: rowNum,
				Message: "must have at least 5 columns: " +
					"Question Text, Type, Options, Correct Answers, Randomize Options[, Marks]",
			})
			continue
		}

		content := strings.TrimSpace(row[0])
		rawType := strings.TrimSpace(row[1])
		rawOptions := strings.TrimSpace(row[2])
		rawCorrect := strings.TrimSpace(row[3])
		rawRandomize := strings.ToLower(strings.TrimSpace(row[4]))

		// Column 6 (index 5): Marks — optional, defaults to 1.
		points := 1
		if len(row) >= 6 {
			rawMarks := strings.TrimSpace(row[5])
			if rawMarks != "" {
				if v, err := strconv.Atoi(rawMarks); err != nil || v < 1 {
					log.Printf("CSV row %d: invalid marks value %q — defaulting to 1", rowNum, rawMarks)
				} else {
					points = v
				}
			}
		}

		if content == "" {
			rowErrors = append(rowErrors, csvRowError{Row: rowNum, Message: "Question Text cannot be empty"})
			continue
		}

		var qType models.QuestionType
		switch strings.ToUpper(rawType) {
		case "MCQ":
			qType = models.QuestionTypeMCQ
		case "MRQ":
			qType = models.QuestionTypeMRQ
		case "CODE":
			qType = models.QuestionTypeCode
		case "THEORY":
			qType = models.QuestionTypeTheory
		default:
			rowErrors = append(rowErrors, csvRowError{
				Row:     rowNum,
				Message: fmt.Sprintf("unknown type %q; expected MCQ, MRQ, code, or theory", rawType),
			})
			continue
		}

		randomize := rawRandomize == "true" || rawRandomize == "yes" || rawRandomize == "1"

		var optJSON, correctJSON datatypes.JSON
		rowOK := true

		if qType == models.QuestionTypeMCQ || qType == models.QuestionTypeMRQ {
			if rawOptions == "" {
				rowErrors = append(rowErrors, csvRowError{Row: rowNum, Message: "MCQ/MRQ questions require Options"})
				continue
			}
			if rawCorrect == "" {
				rowErrors = append(rowErrors, csvRowError{Row: rowNum, Message: "MCQ/MRQ questions require Correct Answers"})
				continue
			}

			opts := csvSplit(rawOptions)
			corrects := csvSplit(rawCorrect)

			// Need at least 2 options.
			if len(opts) < 2 {
				rowErrors = append(rowErrors, csvRowError{Row: rowNum, Message: "MCQ/MRQ requires at least 2 options"})
				continue
			}

			// No duplicate options.
			seen := make(map[string]bool, len(opts))
			for _, o := range opts {
				if seen[o] {
					rowErrors = append(rowErrors, csvRowError{
						Row:     rowNum,
						Message: fmt.Sprintf("duplicate option %q — each option must be unique", o),
					})
					rowOK = false
					break
				}
				seen[o] = true
			}
			if !rowOK {
				continue
			}

			// Each correct answer must exist in the options.
			for _, ca := range corrects {
				if !seen[ca] {
					rowErrors = append(rowErrors, csvRowError{
						Row:     rowNum,
						Message: fmt.Sprintf("correct answer %q is not in the options list", ca),
					})
					rowOK = false
					break
				}
			}
			if !rowOK {
				continue
			}

			// Auto-upgrade MCQ → MRQ when multiple correct answers are provided.
			if qType == models.QuestionTypeMCQ && len(corrects) > 1 {
				qType = models.QuestionTypeMRQ
			}
			// MRQ must have at least 2 correct answers.
			if qType == models.QuestionTypeMRQ && len(corrects) < 2 {
				rowErrors = append(rowErrors, csvRowError{
					Row:     rowNum,
					Message: "MRQ requires at least 2 correct answers",
				})
				continue
			}

			ob, _ := json.Marshal(opts)
			cb, _ := json.Marshal(corrects)
			optJSON = datatypes.JSON(ob)
			correctJSON = datatypes.JSON(cb)
		}

		questions = append(questions, models.Question{
			QuestionSetID:    qs.ID,
			Type:             qType,
			Content:          content,
			Options:          optJSON,
			CorrectAnswers:   correctJSON,
			RandomizeOptions: randomize,
			Points:           points,
		})
	}

	// If any row failed validation, reject the entire batch.
	if len(rowErrors) > 0 {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"message": "no questions were inserted; correct all errors and re-upload",
			"errors":  rowErrors,
		})
	}

	if len(questions) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "no valid questions found in CSV")
	}

	// ── Bulk insert inside a transaction ──────────────────────────────────────
	if err := h.db.Transaction(func(tx *gorm.DB) error {
		return tx.Create(&questions).Error
	}); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "bulk insert failed: "+err.Error())
	}

	return c.Status(fiber.StatusCreated).JSON(uploadResult{Inserted: len(questions)})
}

// csvSplit splits a pipe-delimited string and trims each part.
func csvSplit(s string) []string {
	parts := strings.Split(s, "|")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
