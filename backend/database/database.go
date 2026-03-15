package database

import (
	"github.com/exam-platform/backend/models"
	"github.com/exam-platform/backend/seed"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func Init(dsn string) (*gorm.DB, error) {
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Info),
	})
	if err != nil {
		return nil, err
	}

	// Order matters: parent tables before child tables (FK constraints)
	err = db.AutoMigrate(
		&models.Teacher{},
		&models.Exam{},
		&models.QuestionSet{},
		&models.Question{},
		&models.Submission{},
		&models.SubmissionAnswer{}, // must come after Submission (FK: submission_id)
	)
	if err != nil {
		return nil, err
	}

	// ── Schema cleanup ──────────────────────────────────────────────────────
	// The old single-row-per-answer design stored question_id, answer, and score
	// directly on the submissions table with NOT NULL constraints.
	// GORM AutoMigrate never drops columns, so we remove the stale columns
	// explicitly. IF EXISTS makes this a no-op on fresh databases.
	staleSubmissionCols := []string{"question_id", "answer", "score"}
	for _, col := range staleSubmissionCols {
		db.Exec("ALTER TABLE submissions DROP COLUMN IF EXISTS " + col)
	}

	// ── Seed ────────────────────────────────────────────────────────────────
	// Run after migration so the teachers table and role column always exist.
	seed.EnsureSuperAdmin(db)

	return db, nil
}
