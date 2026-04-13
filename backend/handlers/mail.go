package handlers

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"html"
	"log"
	"math"
	"net/smtp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/go-pdf/fpdf"

	appcrypto "github.com/exam-platform/backend/crypto"
	"github.com/exam-platform/backend/middleware"
	"github.com/exam-platform/backend/models"
	"github.com/gofiber/fiber/v2"
)

// ── Request / response types ──────────────────────────────────────────────────

type mailSettingsRequest struct {
	SMTPSenderName string `json:"smtp_sender_name"`
	SMTPEmail      string `json:"smtp_email"`
	// AppPassword is the plain-text Gmail app password sent from the browser.
	// If empty, the existing stored password is preserved.
	AppPassword string `json:"app_password"`
}

type mailSettingsResponse struct {
	SMTPSenderName string `json:"smtp_sender_name"`
	SMTPEmail      string `json:"smtp_email"`
	// PasswordIsSet is true when an encrypted app password is stored for this
	// teacher. The actual password is never returned.
	PasswordIsSet bool `json:"password_is_set"`
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// GetMailSettings returns the teacher's current SMTP config (password presence only).
// GET /api/me/mail-settings
func (h *Handler) GetMailSettings(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	var teacher models.Teacher
	if err := h.db.First(&teacher, teacherID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "teacher not found")
	}

	return c.JSON(mailSettingsResponse{
		SMTPSenderName: teacher.SMTPSenderName,
		SMTPEmail:      teacher.SMTPEmail,
		PasswordIsSet:  teacher.SMTPAppPassword != "",
	})
}

// SaveMailSettings persists the teacher's SMTP config.
// The app password is AES-256-GCM encrypted before storage.
// If app_password is empty the existing encrypted password is kept.
// PUT /api/me/mail-settings
func (h *Handler) SaveMailSettings(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	var req mailSettingsRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if strings.TrimSpace(req.SMTPEmail) == "" {
		return fiber.NewError(fiber.StatusBadRequest, "smtp_email is required")
	}

	updates := map[string]interface{}{
		"smtp_sender_name": strings.TrimSpace(req.SMTPSenderName),
		"smtp_email":       strings.TrimSpace(req.SMTPEmail),
	}

	if req.AppPassword != "" {
		// Strip spaces — Gmail displays app passwords with spaces for readability
		// but the actual credential has none.
		stripped := strings.ReplaceAll(req.AppPassword, " ", "")
		key := appcrypto.DeriveKey(h.cfg.JWTSecret)
		encrypted, err := appcrypto.Encrypt(stripped, key)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "encryption failed")
		}
		updates["smtp_app_password"] = encrypted
	}

	var teacher models.Teacher
	if err := h.db.First(&teacher, teacherID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "teacher not found")
	}
	if err := h.db.Model(&teacher).Updates(updates).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to save mail settings")
	}

	return c.JSON(mailSettingsResponse{
		SMTPSenderName: teacher.SMTPSenderName,
		SMTPEmail:      teacher.SMTPEmail,
		PasswordIsSet:  teacher.SMTPAppPassword != "" || req.AppPassword != "",
	})
}

// TestMailConnection sends a sample email to the teacher's own address to
// verify the stored SMTP credentials work before sending to students.
// Synchronous — the caller waits for the SMTP round-trip.
// POST /api/me/mail-settings/test
func (h *Handler) TestMailConnection(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	var teacher models.Teacher
	if err := h.db.First(&teacher, teacherID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "teacher not found")
	}
	if teacher.SMTPEmail == "" || teacher.SMTPAppPassword == "" {
		return fiber.NewError(fiber.StatusBadRequest, "mail settings not configured — save your settings first")
	}

	key := appcrypto.DeriveKey(h.cfg.JWTSecret)
	appPassword, err := appcrypto.Decrypt(teacher.SMTPAppPassword, key)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to decrypt credentials")
	}

	senderName := teacher.SMTPSenderName
	if senderName == "" {
		senderName = teacher.Name
	}

	subject := "[ExamPortal] SMTP connection verified"
	body := buildTestEmail(teacher.Name)

	if err := smtpSend(senderName, teacher.SMTPEmail, appPassword, teacher.SMTPEmail, subject, body, nil, ""); err != nil {
		return fiber.NewError(fiber.StatusBadGateway, "SMTP test failed: "+err.Error())
	}

	return c.JSON(fiber.Map{"sent_to": teacher.SMTPEmail})
}

// SendReport sends a graded performance report to a single student.
// The request body may contain pdf_data (base64-encoded PDF generated by the
// browser); when present it is attached directly. Otherwise the backend
// generates a basic PDF as a fallback.
// Synchronous — returns success/error after the SMTP round-trip completes.
// Marks the submission's NotifiedAt timestamp on success.
// POST /api/reports/send/:id
func (h *Handler) SendReport(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	subID, _ := strconv.Atoi(c.Params("id"))
	if subID == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid submission id")
	}

	// Optional body: { pdf_data: "<base64>" }
	var body struct {
		PDFData string `json:"pdf_data"`
	}
	_ = c.BodyParser(&body)

	// Load submission with all answers pre-populated.
	var sub models.Submission
	if err := h.db.Preload("Answers").First(&sub, subID).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "submission not found")
	}
	if sub.Status != models.SubmissionStatusGraded {
		return fiber.NewError(fiber.StatusBadRequest, "submission is not fully graded yet")
	}

	// Confirm the teacher owns this submission's exam.
	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", sub.ExamID, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}

	teacher, appPassword, senderName, err := h.loadSMTPCredentials(teacherID)
	if err != nil {
		return err // already a fiber.Error
	}

	qMap, maxScore := h.loadQuestionsForSubmission(sub)
	htmlBody := buildReportEmail(sub.StudentName, exam.Title, sub.TotalScore, maxScore, sub.Answers, qMap)
	pdfFilename := "report-" + strings.ReplaceAll(strings.ToLower(exam.Title), " ", "-") + ".pdf"

	// Use the browser-generated PDF when provided; fall back to server-side generation.
	var pdfData []byte
	if body.PDFData != "" {
		pdfData, err = base64.StdEncoding.DecodeString(body.PDFData)
		if err != nil {
			log.Printf("mail: invalid base64 PDF for submission %d, falling back: %v", sub.ID, err)
			pdfData = nil
		}
	}
	if pdfData == nil {
		pdfData, err = buildReportPDF(sub.StudentName, exam.Title, sub.TotalScore, maxScore, sub.SubmittedAt, sub.Answers, qMap)
		if err != nil {
			log.Printf("mail: PDF generation failed for submission %d: %v", sub.ID, err)
		}
	}

	subject := "[ExamPortal] Your Report for " + exam.Title
	if err := smtpSend(senderName, teacher.SMTPEmail, appPassword, sub.StudentEmail, subject, htmlBody, pdfData, pdfFilename); err != nil {
		return fiber.NewError(fiber.StatusBadGateway, "failed to send email: "+err.Error())
	}

	now := time.Now()
	h.db.Model(&sub).Update("notified_at", &now)
	sub.NotifiedAt = &now

	return c.JSON(sub)
}

// SendAllReports queues report emails for every graded, not-yet-notified submission
// of an exam. The HTTP call returns immediately (202) while a goroutine sends
// the emails in the background.
// POST /api/reports/send-all?exam_id=N
// Body (optional): { "pdfs": { "<submissionID>": "<base64 PDF>" } }
func (h *Handler) SendAllReports(c *fiber.Ctx) error {
	teacherID, err := middleware.ExtractTeacherID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	examID, _ := strconv.Atoi(c.Query("exam_id"))
	if examID == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "exam_id query param is required")
	}

	// Optional browser-generated PDFs keyed by submission ID string.
	var reqBody struct {
		PDFs map[string]string `json:"pdfs"`
	}
	_ = c.BodyParser(&reqBody)

	var exam models.Exam
	if err := h.db.Where("id = ? AND teacher_id = ?", examID, teacherID).First(&exam).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "exam not found")
	}

	teacher, appPassword, senderName, err := h.loadSMTPCredentials(teacherID)
	if err != nil {
		return err
	}

	// Only send to graded, unnotified submissions.
	var subs []models.Submission
	h.db.Preload("Answers").
		Where("exam_id = ? AND status = ? AND notified_at IS NULL", examID, models.SubmissionStatusGraded).
		Find(&subs)

	if len(subs) == 0 {
		return c.JSON(fiber.Map{"queued": 0, "message": "no pending reports to send"})
	}

	// Pre-load all relevant questions once.
	questions := h.loadQuestionsForExam(uint(examID), subs)
	qMap := make(map[uint]models.Question, len(questions))
	setMaxScore := make(map[uint]float64)
	globalMax := 0.0
	for _, q := range questions {
		qMap[q.ID] = q
		setMaxScore[q.QuestionSetID] += float64(q.Points)
		globalMax += float64(q.Points)
	}

	count := len(subs)
	fromEmail := teacher.SMTPEmail
	examTitle := exam.Title
	pdfFilename := "report-" + strings.ReplaceAll(strings.ToLower(examTitle), " ", "-") + ".pdf"

	browserPDFs := reqBody.PDFs // captured by the goroutine
	go func() {
		for _, sub := range subs {
			maxScore := setMaxScore[sub.QuestionSetID]
			if maxScore == 0 {
				maxScore = globalMax
			}
			htmlBody := buildReportEmail(sub.StudentName, examTitle, sub.TotalScore, maxScore, sub.Answers, qMap)

			// Prefer the browser-generated PDF (same rich format as individual send).
			// Fall back to server-side generation only when none was provided.
			var pdfData []byte
			if b64, ok := browserPDFs[strconv.Itoa(int(sub.ID))]; ok && b64 != "" {
				if decoded, decErr := base64.StdEncoding.DecodeString(b64); decErr == nil {
					pdfData = decoded
				} else {
					log.Printf("mail: invalid base64 PDF for submission %d, falling back: %v", sub.ID, decErr)
				}
			}
			if pdfData == nil {
				var pdfErr error
				pdfData, pdfErr = buildReportPDF(sub.StudentName, examTitle, sub.TotalScore, maxScore, sub.SubmittedAt, sub.Answers, qMap)
				if pdfErr != nil {
					log.Printf("mail: PDF generation failed for submission %d: %v", sub.ID, pdfErr)
					pdfData = nil
				}
			}

			subject := "[ExamPortal] Your Report for " + examTitle
			if err := smtpSend(senderName, fromEmail, appPassword, sub.StudentEmail, subject, htmlBody, pdfData, pdfFilename); err != nil {
				log.Printf("mail: send failed for submission %d (%s): %v", sub.ID, sub.StudentEmail, err)
				continue
			}
			now := time.Now()
			h.db.Model(&models.Submission{}).Where("id = ?", sub.ID).Update("notified_at", &now)
			log.Printf("mail: report sent for submission %d → %s", sub.ID, sub.StudentEmail)
		}
		log.Printf("mail: bulk send complete for exam %d (%d reports)", examID, count)
	}()

	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{
		"queued":  count,
		"message": fmt.Sprintf("%d report(s) queued for delivery", count),
	})
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// loadSMTPCredentials fetches the teacher record, decrypts the app password,
// and returns the credentials needed for smtpSend. Returns a fiber.Error if
// credentials are missing or decryption fails.
func (h *Handler) loadSMTPCredentials(teacherID uint) (teacher models.Teacher, appPassword, senderName string, ferr error) {
	if err := h.db.First(&teacher, teacherID).Error; err != nil {
		ferr = fiber.NewError(fiber.StatusInternalServerError, "could not load teacher record")
		return
	}
	if teacher.SMTPEmail == "" || teacher.SMTPAppPassword == "" {
		ferr = fiber.NewError(fiber.StatusBadRequest, "mail settings not configured — set up your SMTP credentials in Profile → Mail Settings")
		return
	}
	key := appcrypto.DeriveKey(h.cfg.JWTSecret)
	pw, err := appcrypto.Decrypt(teacher.SMTPAppPassword, key)
	if err != nil {
		ferr = fiber.NewError(fiber.StatusInternalServerError, "failed to decrypt mail credentials")
		return
	}
	appPassword = pw
	senderName = teacher.SMTPSenderName
	if senderName == "" {
		senderName = teacher.Name
	}
	return
}

// loadQuestionsForSubmission returns a question map and the maximum possible
// score for the student's assigned question set (or the full exam if unknown).
func (h *Handler) loadQuestionsForSubmission(sub models.Submission) (map[uint]models.Question, float64) {
	var questions []models.Question
	if sub.QuestionSetID > 0 {
		h.db.Where("question_set_id = ?", sub.QuestionSetID).Find(&questions)
	} else {
		h.db.Joins("JOIN question_sets ON questions.question_set_id = question_sets.id").
			Where("question_sets.exam_id = ?", sub.ExamID).Find(&questions)
	}
	qMap := make(map[uint]models.Question, len(questions))
	maxScore := 0.0
	for _, q := range questions {
		qMap[q.ID] = q
		maxScore += float64(q.Points)
	}
	return qMap, maxScore
}

// loadQuestionsForExam loads questions covering all question sets referenced
// by the given submissions.
func (h *Handler) loadQuestionsForExam(examID uint, subs []models.Submission) []models.Question {
	setIDs := make(map[uint]bool)
	for _, s := range subs {
		if s.QuestionSetID > 0 {
			setIDs[s.QuestionSetID] = true
		}
	}
	var questions []models.Question
	if len(setIDs) > 0 {
		ids := make([]uint, 0, len(setIDs))
		for id := range setIDs {
			ids = append(ids, id)
		}
		h.db.Where("question_set_id IN ?", ids).Find(&questions)
	} else {
		h.db.Joins("JOIN question_sets ON questions.question_set_id = question_sets.id").
			Where("question_sets.exam_id = ?", examID).Find(&questions)
	}
	return questions
}

// sanitizeLatin1 replaces characters outside ISO-8859-1 with '?' so that
// the PDF standard fonts (Helvetica) render them without corruption.
func sanitizeLatin1(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r > unicode.MaxLatin1 {
			b.WriteByte('?')
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// b64Wrap base64-encodes data and wraps lines at 76 chars per RFC 2045.
func b64Wrap(data []byte) string {
	enc := base64.StdEncoding.EncodeToString(data)
	var sb strings.Builder
	for i := 0; i < len(enc); i += 76 {
		end := i + 76
		if end > len(enc) {
			end = len(enc)
		}
		sb.WriteString(enc[i:end])
		sb.WriteString("\r\n")
	}
	return sb.String()
}

// smtpSend connects to smtp.gmail.com:587 with STARTTLS and sends an email.
// When pdfData is non-nil the message is multipart/mixed with an HTML body
// and the PDF as an attachment; otherwise a plain HTML email is sent.
func smtpSend(fromName, fromEmail, appPassword, toEmail, subject, htmlBody string, pdfData []byte, pdfFilename string) error {
	auth := smtp.PlainAuth("", fromEmail, appPassword, "smtp.gmail.com")

	var msg strings.Builder
	msg.WriteString("From: " + fromName + " <" + fromEmail + ">\r\n")
	msg.WriteString("To: " + toEmail + "\r\n")
	msg.WriteString("Subject: " + subject + "\r\n")
	msg.WriteString("MIME-Version: 1.0\r\n")

	if pdfData != nil {
		boundary := "==ExamPortalBoundary" + strconv.FormatInt(time.Now().UnixNano(), 36) + "=="
		msg.WriteString("Content-Type: multipart/mixed; boundary=\"" + boundary + "\"\r\n\r\n")

		// ── HTML part ──────────────────────────────────────────────────────
		msg.WriteString("--" + boundary + "\r\n")
		msg.WriteString("Content-Type: text/html; charset=\"UTF-8\"\r\n")
		msg.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
		msg.WriteString(b64Wrap([]byte(htmlBody)))

		// ── PDF attachment ─────────────────────────────────────────────────
		msg.WriteString("--" + boundary + "\r\n")
		msg.WriteString("Content-Type: application/pdf\r\n")
		msg.WriteString("Content-Transfer-Encoding: base64\r\n")
		msg.WriteString("Content-Disposition: attachment; filename=\"" + pdfFilename + "\"\r\n\r\n")
		msg.WriteString(b64Wrap(pdfData))

		msg.WriteString("--" + boundary + "--\r\n")
	} else {
		msg.WriteString("Content-Type: text/html; charset=\"UTF-8\"\r\n")
		msg.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
		msg.WriteString(b64Wrap([]byte(htmlBody)))
	}

	return smtp.SendMail("smtp.gmail.com:587", auth, fromEmail, []string{toEmail}, []byte(msg.String()))
}

// ── PDF builder ───────────────────────────────────────────────────────────────

// pdfScoreAppearance returns RGB colors and a grade label for the given percentage.
func pdfScoreAppearance(pct float64) (bg [3]int, fg [3]int, label string) {
	switch {
	case pct >= 80:
		return [3]int{240, 253, 244}, [3]int{22, 101, 52}, "Excellent"
	case pct >= 60:
		return [3]int{239, 246, 255}, [3]int{30, 64, 175}, "Good"
	case pct >= 40:
		return [3]int{255, 251, 235}, [3]int{146, 64, 14}, "Needs Improvement"
	default:
		return [3]int{254, 242, 242}, [3]int{153, 27, 27}, "Unsatisfactory"
	}
}

// buildReportPDF generates a PDF performance report and returns the raw bytes.
// Uses only built-in PDF fonts (Helvetica) — no external font files required.
func buildReportPDF(
	studentName, examTitle string,
	totalScore, maxScore float64,
	submittedAt time.Time,
	answers []models.SubmissionAnswer,
	qMap map[uint]models.Question,
) ([]byte, error) {
	pdf := fpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(15, 15, 15)
	pdf.SetAutoPageBreak(true, 20)

	pdf.SetFooterFunc(func() {
		pdf.SetY(-12)
		pdf.SetFont("Helvetica", "", 8)
		pdf.SetTextColor(148, 163, 184)
		pdf.CellFormat(0, 5, "ExamPortal - Exam Management Platform", "", 0, "C", false, 0, "")
	})

	pdf.AddPage()
	// Font must be set before any CellFormat/MultiCell call.
	pdf.SetFont("Helvetica", "", 10)

	const pageW = 210.0

	// ── Header bar (use Rect for background, no font required) ───────────────
	pdf.SetFillColor(30, 41, 59)
	pdf.Rect(0, 0, pageW, 28, "F")

	pdf.SetTextColor(255, 255, 255)
	pdf.SetFont("Helvetica", "B", 18)
	pdf.SetXY(15, 7)
	pdf.CellFormat(0, 9, "ExamPortal", "", 1, "L", false, 0, "")

	pdf.SetFont("Helvetica", "", 8)
	pdf.SetTextColor(148, 163, 184)
	pdf.SetXY(15, 17)
	pdf.CellFormat(0, 6, "PERFORMANCE REPORT", "", 1, "L", false, 0, "")

	// ── Score banner ──────────────────────────────────────────────────────────
	pct := 0.0
	if maxScore > 0 {
		pct = totalScore / maxScore * 100
	}
	scoreBg, scoreFg, gradeLabel := pdfScoreAppearance(pct)

	pdf.SetFillColor(scoreBg[0], scoreBg[1], scoreBg[2])
	pdf.Rect(0, 28, pageW, 52, "F")

	pdf.SetTextColor(scoreFg[0], scoreFg[1], scoreFg[2])
	pdf.SetFont("Helvetica", "B", 36)
	pdf.SetXY(0, 34)
	pdf.CellFormat(pageW, 14, fmt.Sprintf("%.1f%%", pct), "", 1, "C", false, 0, "")

	pdf.SetFont("Helvetica", "", 11)
	pdf.SetXY(0, 50)
	pdf.CellFormat(pageW, 7, formatScore(totalScore)+" / "+formatScore(maxScore)+" pts", "", 1, "C", false, 0, "")

	pdf.SetFont("Helvetica", "B", 9)
	pdf.SetXY(0, 59)
	pdf.CellFormat(pageW, 6, strings.ToUpper(gradeLabel), "", 1, "C", false, 0, "")

	// ── Student info ──────────────────────────────────────────────────────────
	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 12)
	pdf.SetXY(15, 92)
	pdf.CellFormat(0, 7, "Hi "+sanitizeLatin1(studentName)+",", "", 1, "L", false, 0, "")

	pdf.SetFont("Helvetica", "", 10)
	pdf.SetTextColor(100, 116, 139)
	pdf.SetX(15)
	pdf.MultiCell(180, 5.5, "Your submission for \""+sanitizeLatin1(examTitle)+"\" has been graded. Please find your full report below.", "", "L", false)

	pdf.Ln(2)
	pdf.SetFont("Helvetica", "", 9)
	pdf.SetX(15)
	pdf.CellFormat(28, 5, "Submitted:", "", 0, "L", false, 0, "")
	pdf.SetFont("Helvetica", "B", 9)
	pdf.CellFormat(0, 5, submittedAt.Format("2 January 2006 at 15:04"), "", 1, "L", false, 0, "")

	pdf.Ln(4)

	// ── Divider ───────────────────────────────────────────────────────────────
	pdf.SetDrawColor(226, 232, 240)
	pdf.Line(15, pdf.GetY(), 195, pdf.GetY())
	pdf.Ln(6)

	// ── Question breakdown header ─────────────────────────────────────────────
	pdf.SetFont("Helvetica", "B", 8)
	pdf.SetTextColor(148, 163, 184)
	pdf.SetX(15)
	pdf.CellFormat(0, 5, "QUESTION BREAKDOWN", "", 1, "L", false, 0, "")
	pdf.Ln(4)

	// ── Answer rows ───────────────────────────────────────────────────────────
	rowNum := 0
	for _, ans := range answers {
		q, ok := qMap[ans.QuestionID]
		if !ok || ans.Score == nil {
			continue
		}
		score := *ans.Score
		rowStartY := pdf.GetY()

		// Q# + type label
		pdf.SetFont("Helvetica", "B", 8)
		pdf.SetTextColor(148, 163, 184)
		pdf.SetX(15)
		pdf.CellFormat(160, 5, fmt.Sprintf("Q%d  -  %s", rowNum+1, strings.ToUpper(string(q.Type))), "", 1, "L", false, 0, "")
		pdf.Ln(1)

		// Question content
		content := sanitizeLatin1(q.Content)
		if len([]rune(content)) > 400 {
			runes := []rune(content)
			content = string(runes[:397]) + "..."
		}
		pdf.SetFont("Helvetica", "", 10)
		pdf.SetTextColor(30, 41, 59)
		pdf.SetX(15)
		pdf.MultiCell(155, 5, content, "", "L", false)

		// Feedback
		if ans.Feedback != "" {
			pdf.Ln(1)
			pdf.SetFont("Helvetica", "I", 9)
			pdf.SetTextColor(100, 116, 139)
			pdf.SetX(15)
			pdf.MultiCell(155, 5, "Feedback: "+sanitizeLatin1(ans.Feedback), "", "L", false)
		}

		// Score — overlay at top-right of this row
		var scoreRGB [3]int
		ratio := score / float64(q.Points)
		switch {
		case ratio >= 1:
			scoreRGB = [3]int{21, 128, 61}
		case ratio > 0:
			scoreRGB = [3]int{217, 119, 6}
		default:
			scoreRGB = [3]int{220, 38, 38}
		}
		endY := pdf.GetY()
		pdf.SetFont("Helvetica", "B", 11)
		pdf.SetTextColor(scoreRGB[0], scoreRGB[1], scoreRGB[2])
		pdf.SetXY(160, rowStartY+1)
		pdf.CellFormat(35, 5, fmt.Sprintf("%s / %d", formatScore(score), q.Points), "", 0, "R", false, 0, "")

		pdf.SetXY(15, endY)
		pdf.Ln(4)
		pdf.SetDrawColor(226, 232, 240)
		pdf.Line(15, pdf.GetY(), 195, pdf.GetY())
		pdf.Ln(4)

		rowNum++
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ── Email builders ────────────────────────────────────────────────────────────

func formatScore(f float64) string {
	if f == math.Trunc(f) {
		return strconv.Itoa(int(f))
	}
	return fmt.Sprintf("%.1f", f)
}

// scoreAppearance returns background colour, text colour, badge colour, and
// grade label appropriate for the given percentage.
func scoreAppearance(pct float64) (bg, text, badge, label string) {
	switch {
	case pct >= 80:
		return "#f0fdf4", "#166534", "#15803d", "Excellent"
	case pct >= 60:
		return "#eff6ff", "#1e40af", "#1d4ed8", "Good"
	case pct >= 40:
		return "#fffbeb", "#92400e", "#d97706", "Needs Improvement"
	default:
		return "#fef2f2", "#991b1b", "#dc2626", "Unsatisfactory"
	}
}

// buildAnswerRows generates the inner <tr> rows for the question breakdown table.
func buildAnswerRows(answers []models.SubmissionAnswer, qMap map[uint]models.Question) string {
	var b strings.Builder
	row := 0
	for _, ans := range answers {
		q, ok := qMap[ans.QuestionID]
		if !ok || ans.Score == nil {
			continue
		}
		score := *ans.Score
		scoreColor := "#15803d"
		if score < float64(q.Points) {
			scoreColor = "#d97706"
		}
		if score == 0 {
			scoreColor = "#dc2626"
		}

		qContent := html.EscapeString(q.Content)
		if len(qContent) > 280 {
			qContent = qContent[:277] + "…"
		}

		feedbackHTML := ""
		if ans.Feedback != "" {
			feedbackHTML = `<p style="margin:6px 0 0;font-size:12px;color:#64748b;line-height:1.6;">` +
				strings.ReplaceAll(html.EscapeString(ans.Feedback), "\n", "<br>") +
				`</p>`
		}

		rowBg := "#ffffff"
		if row%2 == 1 {
			rowBg = "#f8fafc"
		}
		b.WriteString(`<tr style="background:` + rowBg + `;border-top:1px solid #e2e8f0;">` +
			`<td style="padding:12px 16px;vertical-align:top;">` +
			`<p style="margin:0;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">Q` + strconv.Itoa(row+1) + `</p>` +
			`<p style="margin:4px 0 0;font-size:13px;color:#1e293b;line-height:1.5;">` + qContent + `</p>` +
			feedbackHTML +
			`</td>` +
			`<td style="padding:12px 16px;text-align:right;vertical-align:top;white-space:nowrap;">` +
			`<span style="font-size:14px;font-weight:700;color:` + scoreColor + `;">` + formatScore(score) + `</span>` +
			`<span style="font-size:12px;color:#94a3b8;"> / ` + strconv.Itoa(q.Points) + `</span>` +
			`</td></tr>`)
		row++
	}
	return b.String()
}

// buildReportEmail generates the full HTML email body for a student's performance report.
func buildReportEmail(studentName, examTitle string, totalScore, maxScore float64, answers []models.SubmissionAnswer, qMap map[uint]models.Question) string {
	pct := 0.0
	if maxScore > 0 {
		pct = totalScore / maxScore * 100
	}
	scoreBg, scoreText, gradeBadge, gradeLabel := scoreAppearance(pct)
	pctStr := fmt.Sprintf("%.1f", pct)
	totalStr := formatScore(totalScore)
	maxStr := formatScore(maxScore)

	answerRows := buildAnswerRows(answers, qMap)
	answersSection := ""
	if answerRows != "" {
		answersSection = `
<tr>
  <td style="padding:24px 32px 8px;">
    <p style="margin:0 0 12px;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">Question Breakdown</p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <tr style="background:#f8fafc;">
        <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Question</th>
        <th style="padding:10px 16px;text-align:right;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;">Score</th>
      </tr>` + answerRows + `
    </table>
  </td>
</tr>`
	}

	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Exam Report – ExamPortal</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f1f5f9;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

<!-- Header -->
<tr>
  <td style="background:#1e293b;padding:24px 32px;">
    <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">ExamPortal</h1>
    <p style="margin:4px 0 0;color:rgba(255,255,255,0.55);font-size:12px;text-transform:uppercase;letter-spacing:1.2px;">Performance Report</p>
  </td>
</tr>

<!-- Score Banner -->
<tr>
  <td style="background:` + scoreBg + `;padding:32px;text-align:center;">
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:` + scoreText + `;text-transform:uppercase;letter-spacing:1px;opacity:0.75;">Final Score</p>
    <p style="margin:0;font-size:62px;font-weight:800;color:` + scoreText + `;line-height:1;letter-spacing:-2px;">` + pctStr + `%</p>
    <p style="margin:8px 0 0;font-size:15px;color:` + scoreText + `;opacity:0.7;">` + totalStr + ` / ` + maxStr + ` pts</p>
    <div style="margin-top:14px;">
      <span style="display:inline-block;background:` + gradeBadge + `;color:white;padding:5px 18px;border-radius:9999px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;">` + gradeLabel + `</span>
    </div>
  </td>
</tr>

<!-- Greeting -->
<tr>
  <td style="padding:28px 32px 8px;">
    <p style="margin:0;font-size:18px;font-weight:700;color:#0f172a;">Hi ` + html.EscapeString(studentName) + `,</p>
    <p style="margin:10px 0 0;font-size:14px;color:#64748b;line-height:1.7;">
      Your submission for <strong style="color:#1e293b;">` + html.EscapeString(examTitle) + `</strong> has been graded.
      Your full report is attached as a PDF.
    </p>
  </td>
</tr>
` + answersSection + `

<!-- Divider -->
<tr><td style="height:1px;background:#e2e8f0;font-size:0;line-height:0;">&nbsp;</td></tr>

<!-- Footer -->
<tr>
  <td style="background:#f8fafc;padding:20px 32px;text-align:center;">
    <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
      This report was sent automatically by <strong style="color:#64748b;">ExamPortal</strong>.<br>
      Please do not reply to this email.
    </p>
    <p style="margin:8px 0 0;font-size:11px;color:#cbd5e1;">© 2026 ExamPortal · Exam Management Platform</p>
  </td>
</tr>

</table>
</td></tr>
</table>
</body>
</html>`
}

// buildTestEmail generates a simple confirmation email body for the test connection.
func buildTestEmail(teacherName string) string {
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>ExamPortal – Connection Verified</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f1f5f9;padding:40px 0;">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
<tr><td style="background:#1e293b;padding:24px 32px;">
  <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">ExamPortal</h1>
</td></tr>
<tr><td style="padding:32px;text-align:center;">
  <div style="font-size:48px;margin-bottom:16px;">✓</div>
  <h2 style="margin:0 0 10px;font-size:20px;font-weight:700;color:#0f172a;">Mail settings verified!</h2>
  <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;">
    Hi ` + html.EscapeString(teacherName) + `, your SMTP configuration is working correctly.<br>
    You can now send graded performance reports directly to your students.
  </p>
</td></tr>
<tr><td style="background:#f8fafc;padding:16px 32px;text-align:center;">
  <p style="margin:0;font-size:11px;color:#cbd5e1;">© 2026 ExamPortal · Exam Management Platform</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}
