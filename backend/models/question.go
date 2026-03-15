package models

import "gorm.io/datatypes"

type QuestionType string

const (
	QuestionTypeMCQ    QuestionType = "MCQ"    // single correct answer
	QuestionTypeMRQ    QuestionType = "MRQ"    // multiple correct answers
	QuestionTypeCode   QuestionType = "code"
	QuestionTypeTheory QuestionType = "theory"
)

type Question struct {
	ID            uint         `gorm:"primaryKey"            json:"id"`
	QuestionSetID uint         `gorm:"not null;index"        json:"question_set_id"`
	Type          QuestionType `gorm:"type:varchar(10);not null" json:"type"`
	Content       string       `gorm:"type:text;not null"    json:"content"`

	// Options: JSON array of choice strings for MCQ/MRQ. Null for code/theory.
	Options datatypes.JSON `json:"options"`

	// CorrectAnswers: JSON array of correct option strings.
	// MCQ has exactly one entry; MRQ has two or more.
	CorrectAnswers datatypes.JSON `gorm:"column:correct_answers" json:"correct_answers,omitempty"`

	// RandomizeOptions: when true, the student UI shuffles the order of Options.
	RandomizeOptions bool `gorm:"default:false" json:"randomize_options"`

	Points int `gorm:"default:1" json:"points"`

	// Language is the compiler/runtime for code questions: "python", "c", or "cpp".
	// Empty for MCQ, MRQ, and theory questions.
	Language string `gorm:"type:varchar(20);default:''" json:"language"`
}
