package models

type QuestionSet struct {
	ID        uint       `gorm:"primaryKey"        json:"id"`
	ExamID    uint       `gorm:"not null;index"    json:"exam_id"`
	Title     string     `gorm:"not null"          json:"title"`
	Order     int        `gorm:"default:0"         json:"order"`
	Questions []Question `gorm:"foreignKey:QuestionSetID" json:"questions,omitempty"`
}
