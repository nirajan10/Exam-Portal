package models

// AppSettings is a single-row table holding platform-wide feature flags.
// The row is seeded on startup; there is always exactly one row with ID = 1.
type AppSettings struct {
	ID            uint `gorm:"primaryKey"                      json:"-"`
	LLMAutoGrader bool `gorm:"not null;default:true"           json:"llm_auto_grader"`
}
