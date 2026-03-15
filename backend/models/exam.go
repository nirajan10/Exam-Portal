package models

import "time"

type Exam struct {
	ID        uint    `gorm:"primaryKey"     json:"id"`
	TeacherID uint    `gorm:"not null;index" json:"teacher_id"`
	Teacher   Teacher `gorm:"foreignKey:TeacherID" json:"-"`

	Title           string    `gorm:"not null"            json:"title"`
	Description     string    `                           json:"description"`
	DurationMinutes int       `gorm:"not null;default:60" json:"duration_minutes"`
	CreatedAt       time.Time `                           json:"created_at"`

	// Security & proctoring
	// RandomizeQuestionOrder shuffles the sequence of questions each student sees.
	RandomizeQuestionOrder bool `gorm:"default:false" json:"randomize_question_order"`
	CameraProctoring       bool `gorm:"default:false" json:"camera_proctoring_required"`
	ViolationLimit         int  `gorm:"default:0"     json:"violation_limit"`
	// MaxCodeRuns: 0 = code execution disabled, 1–3 = allowed runs per question.
	MaxCodeRuns int `gorm:"default:0" json:"max_code_runs"`

	// IsActive controls whether students can access and start this exam.
	IsActive bool `gorm:"default:false" json:"is_active"`
	// StartedAt is set to the current time when the teacher first activates the exam.
	// Nil means the exam has never been started.
	StartedAt *time.Time `gorm:"column:started_at" json:"started_at"`

	// BufferDurationMins is the lead-in window before the exam officially begins.
	// During this window students see a countdown but no questions (questions are hidden).
	// Absolute timeline: T0=StartedAt, BufferEnd=T0+Buffer, ExamEnd=BufferEnd+Duration, GraceEnd=ExamEnd+2min.
	BufferDurationMins int `gorm:"column:buffer_duration_minutes;default:0" json:"buffer_duration_minutes"`

	// LoginCode is the PIN/code students enter in the lobby to join this exam.
	LoginCode string `gorm:"default:''" json:"login_code"`

	QuestionSets []QuestionSet `gorm:"foreignKey:ExamID" json:"question_sets,omitempty"`
}
