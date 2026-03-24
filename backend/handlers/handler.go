package handlers

import (
	"sync"
	"time"

	"github.com/exam-platform/backend/config"
	"github.com/exam-platform/backend/runner"
	"gorm.io/gorm"
)

// Handler holds shared dependencies for all HTTP handlers.
type Handler struct {
	db           *gorm.DB
	runner       *runner.Runner
	cfg          *config.Config
	RoomHub      *RoomHub
	loginLimiter *loginLimiter
}

func New(db *gorm.DB, r *runner.Runner, cfg *config.Config) *Handler {
	return &Handler{
		db:           db,
		runner:       r,
		cfg:          cfg,
		RoomHub:      NewRoomHub(),
		loginLimiter: newLoginLimiter(5, 15*time.Minute),
	}
}

// ── Login rate limiter ───────────────────────────────────────────────────────

type loginAttempt struct {
	failures    int
	lockedUntil time.Time
}

type loginLimiter struct {
	mu       sync.Mutex
	attempts map[string]*loginAttempt
	maxFails int
	lockout  time.Duration
}

func newLoginLimiter(maxFails int, lockout time.Duration) *loginLimiter {
	return &loginLimiter{
		attempts: make(map[string]*loginAttempt),
		maxFails: maxFails,
		lockout:  lockout,
	}
}

// check returns the remaining lockout duration if the key is locked out, or 0.
func (l *loginLimiter) check(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.attempts[key]
	if !ok {
		return 0
	}
	if remaining := time.Until(a.lockedUntil); remaining > 0 {
		return remaining
	}
	return 0
}

// recordFailure increments the failure counter and locks the key after maxFails.
func (l *loginLimiter) recordFailure(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.attempts[key]
	if !ok {
		a = &loginAttempt{}
		l.attempts[key] = a
	}
	// Reset counter if previous lockout has expired.
	if !a.lockedUntil.IsZero() && time.Now().After(a.lockedUntil) {
		a.failures = 0
		a.lockedUntil = time.Time{}
	}
	a.failures++
	if a.failures >= l.maxFails {
		a.lockedUntil = time.Now().Add(l.lockout)
	}
}

// recordSuccess clears the failure counter for the key.
func (l *loginLimiter) recordSuccess(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, key)
}
