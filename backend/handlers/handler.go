package handlers

import (
	"github.com/exam-platform/backend/config"
	"github.com/exam-platform/backend/runner"
	"gorm.io/gorm"
)

// Handler holds shared dependencies for all HTTP handlers.
type Handler struct {
	db      *gorm.DB
	runner  *runner.Runner
	cfg     *config.Config
	RoomHub *RoomHub
}

func New(db *gorm.DB, r *runner.Runner, cfg *config.Config) *Handler {
	return &Handler{db: db, runner: r, cfg: cfg, RoomHub: NewRoomHub()}
}
