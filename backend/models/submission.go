package models

import "time"

// SubmissionStatus indicates whether all answers have been graded.
type SubmissionStatus string

const (
	SubmissionStatusGraded         SubmissionStatus = "graded"
	SubmissionStatusPendingGrading SubmissionStatus = "pending_grading"
)

// Submission represents one student's complete exam attempt.
// One row is created per student per exam when they click "Submit Exam".
// MCQ/MRQ questions are auto-graded immediately; theory/code require manual grading.
type Submission struct {
	ID           uint             `gorm:"primaryKey"                               json:"id"`
	ExamID       uint             `gorm:"not null;index"                           json:"exam_id"`
	// SessionID is the backend-generated student identifier (e.g. "STU-A1B2C3D4").
	// Deterministic from HMAC(secret, examId|email) — same student always gets the same ID.
	SessionID     string `gorm:"type:varchar(20);index"                   json:"session_id"`
	// QuestionSetID and SetName record which question set this student received.
	// Populated on submit by inspecting the first answer's question's question_set_id.
	QuestionSetID uint   `gorm:"default:0"             json:"question_set_id"`
	SetName       string `gorm:"type:varchar(255)"     json:"set_name"`
	StudentName  string           `gorm:"not null"                                 json:"student_name"`
	StudentEmail string           `gorm:"not null;index"                           json:"student_email"`
	SubmittedAt  time.Time        `                                                json:"submitted_at"`
	TotalScore   float64          `gorm:"default:0"                                json:"total_score"`
	Status       SubmissionStatus `gorm:"type:varchar(20);default:'pending_grading'" json:"status"`
	// NotifiedAt is set when the teacher successfully emails the student's report.
	// nil means no report email has been sent yet.
	NotifiedAt *time.Time `json:"notified_at"`

	// Answers is preloaded only when explicitly requested (e.g., grading view).
	Answers []SubmissionAnswer `gorm:"foreignKey:SubmissionID" json:"answers,omitempty"`
}

// SubmissionAnswer stores a student's answer for one question within a Submission.
type SubmissionAnswer struct {
	ID           uint     `gorm:"primaryKey"                                    json:"id"`
	SubmissionID uint     `gorm:"not null;index;constraint:OnDelete:CASCADE"    json:"submission_id"`
	QuestionID   uint     `gorm:"not null"                                      json:"question_id"`
	Answer       string   `gorm:"type:text"      json:"answer"`
	// Score is nil until graded; 0 or full points once graded (MCQ auto-graded on submit).
	Score    *float64 `                  json:"score"`
	Feedback string   `gorm:"type:text"  json:"feedback"`
}
