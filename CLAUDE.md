# Exam Portal

Secure online exam platform. Teachers create exams (MCQ, MRQ, code, theory), students join without accounts via PIN. Code questions execute in isolated Docker sandboxes. Teachers send graded PDF reports via their own Gmail SMTP. Live video proctoring via WebRTC with fullscreen lockdown and violation tracking.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go 1.25, Fiber v2.52, GORM v1.25, PostgreSQL 16 |
| Auth | golang-jwt/jwt v5, bcrypt cost 12 |
| Code execution | Docker SDK v26, ephemeral sibling containers |
| PDF (backend) | go-pdf/fpdf v0.9 (fallback reports) |
| Frontend | React 18, TypeScript 5.4, Vite 5.3, Axios 1.7 |
| PDF (frontend) | jsPDF 2.5 + jsPDF-autotable 3.8, JSZip 3.10 |
| Video proctoring | Native WebRTC + WebSocket signaling (star topology) |
| Serving | Nginx 1.25-alpine (SPA + reverse proxy) |
| LLM grading | Python 3.11, FastAPI, llama-cpp-python, Celery + Redis |
| Orchestration | Docker Compose |

## Key Directories

```
backend/
  config/       env var loading — config.go
  crypto/       AES-256-GCM helpers for credentials at rest — aes.go
  database/     GORM init + AutoMigrate (FK order matters) — database.go
  models/       source of truth for DB schema (teacher, exam, question, submission, feedback, settings)
  handlers/     one file per resource; all share *Handler receiver
  middleware/   JWT validation + role extraction — jwt.go
  runner/       Docker sandbox — most security-sensitive code
  routes/       public / JWT-protected / admin split — routes.go
  seed/         superadmin bootstrap on startup — seed.go

llm-service/
  main.py       FastAPI app — /grade (sync), /grade/batch + /grade/status (Celery async)
  tasks.py      Celery worker — loads own model copy, concurrency=1
  Dockerfile    Builds llama-cpp-python with CPU support

frontend/src/
  api/client.ts       single Axios instance + all TS interfaces + API helpers
  pages/              route-level components (one per page)
  components/         Navbar, ProtectedRoute, TeacherLayout, DraggableCamera, ChatPanel, FeedbackModal
  contexts/           ThemeContext (light/dark via CSS vars + data-theme attribute)
  hooks/              useWebRTC.ts — WebRTC peer connections, signaling, audio/video
  utils/              generateStudentPDF.ts — rich PDF for download and email
```

## Build & Run

```bash
# Full stack
cp .env.example .env          # fill DB_PASSWORD, JWT_SECRET, DOCKER_GID
docker compose up --build

# Backend only
cd backend && go build ./... && go run .

# Frontend only (proxies /api to localhost:8080)
cd frontend && npm install && npm run dev

# Rebuild one service
docker compose build backend
docker compose build frontend

# Type-check frontend (also runs as part of npm run build)
cd frontend && npx tsc --noEmit
```

## Essential Facts

- Frontend: **port 9999**, backend: **port 8080**, LLM service: **port 8000** (`docker-compose.yml`)
- Nginx proxies `/api/` → `backend:8080`, `/api/ws` → WebSocket — no CORS in production (`frontend/nginx.conf`)
- Body limit is **6 MB** for profile picture uploads (`main.go:37`)
- Backend mounts `/var/run/docker.sock` to spawn sandbox containers (`docker-compose.yml`)
- DB schema auto-migrates on every startup; FK order matters (`database/database.go:20-28`)
- Superadmin seeded from `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars (`seed/seed.go`); teachers provisioned by admins only
- SMTP credentials AES-256-GCM encrypted at rest, key derived from `JWT_SECRET` (`crypto/aes.go`)
- Students require no accounts — join via exam PIN, identified by name + email
- Session IDs are deterministic HMAC-based — same student always gets same set on rejoin (`handlers/join.go`)
- WebRTC uses star topology: students connect only to teacher, not to each other (`hooks/useWebRTC.ts`)
- Login rate-limited: 5 failures per IP → 15-min lockout, in-memory (`handlers/handler.go:31-92`)
- LLM auto-grader toggleable by superadmin via `AppSettings` single-row table (`models/settings.go`)
- Offline submissions survive exam delete+reimport via positional question ID remapping (`handlers/submission.go`)
- TypeScript strict mode — unused variables cause build failures
- No automated test suite — verify with `go build ./...` (backend) and `npx tsc --noEmit` (frontend)

## API Surface

Full route list: `routes/routes.go`. Three auth levels:

| Group | Key routes |
|-------|-----------|
| Public | `POST /auth/login`, `GET /exams/active`, `POST /exams/:id/verify-pin`, `POST /exams/:id/join`, `POST /exams/:id/submit`, `POST /exams/:id/execute` |
| JWT-protected | `/exams` CRUD, `/question-sets` CRUD, `/questions` CRUD, `/submissions` CRUD + grade, `/reports/send/:id` + `/send-all`, `/me` profile, `/me/mail-settings`, `/exams/:id/analytics`, `/feedback`, `GET /settings`, `/llm/health`, `/submissions/:id/auto-grade`, `/exams/:id/auto-grade-all` |
| Superadmin | `/admin/teachers` CRUD, `/admin/feedback` list + delete, `PATCH /admin/settings` |

## Additional Documentation

| Topic | File |
|-------|------|
| Architectural patterns, DI, ownership, API conventions, security invariants | `.claude/docs/architectural_patterns.md` |
