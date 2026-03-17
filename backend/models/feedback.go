package models

import "time"

type FeedbackType string

const (
	FeedbackBug         FeedbackType = "bug"
	FeedbackSuggestion  FeedbackType = "suggestion"
	FeedbackUsability   FeedbackType = "usability"
	FeedbackPerformance FeedbackType = "performance"
	FeedbackOther       FeedbackType = "other"
)

type Feedback struct {
	ID        uint         `gorm:"primaryKey"                                      json:"id"`
	TeacherID uint         `gorm:"not null;index"                                  json:"teacher_id"`
	Teacher   Teacher      `gorm:"foreignKey:TeacherID"                            json:"teacher,omitempty"`
	Type      FeedbackType `gorm:"type:varchar(30);not null"                       json:"type"`
	Subject   string       `gorm:"type:varchar(255);not null"                      json:"subject"`
	Body      string       `gorm:"type:text;not null"                              json:"body"`
	CreatedAt time.Time    `                                                       json:"created_at"`
}
