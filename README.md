# Exam Portal

A secure online exam platform where teachers create and manage exams with MCQ, MRQ, code execution, and theory questions. Students join anonymously via PIN — no account required. Code answers run inside isolated Docker sandboxes. Teachers grade submissions and send PDF reports via their own Gmail SMTP credentials. Live video proctoring with fullscreen lockdown and violation tracking keeps exams secure.

## Features

- **Multiple question types** — MCQ, MRQ (multi-select), code execution (C, C++, Python), and free-text theory
- **Isolated code execution** — student code runs in ephemeral Docker containers with no network, 64 MB memory limit, 50 PID cap, and read-only root filesystem
- **Live video proctoring** — WebRTC star topology (students stream to teacher only); teacher monitors all feeds from a dedicated exam monitor page
- **Fullscreen lockdown** — enforced from buffer phase through exam end; auto-recovery on click; 5-second grace period on exit, then escalating violations every 2 seconds until rejoin or auto-submit
- **Violation tracking** — tab switches, new windows, fullscreen exits, and paste events are tracked; configurable violation limit triggers auto-submission
- **Role-based access** — superadmin, teacher, and anonymous student tiers
- **Question sets** — randomized sets so each student receives a different variant; deterministic assignment ensures same student always gets the same set on rejoin
- **Analytics & grading** — per-question score distributions, manual grading for theory/code answers, bulk ZIP export of PDF reports
- **Email reports** — teachers send graded PDF reports to students via their own Gmail SMTP credentials (BYOM); rich browser-generated PDFs or backend fallback
- **Bulk import** — CSV upload for creating questions in bulk
- **Offline submission backup** — students download an encrypted backup of their answers; teachers reimport via SHA-256 tamper-checked upload
- **PIN-protected exams** — optional access code required to join
- **Teacher feedback** — teachers submit bug reports, suggestions, usability, performance, or general feedback; admins review and manage from a dedicated panel
- **AI auto-grading** — local LLM (qwen2.5-7b-instruct-q3_k_m.gguf) grades theory and code answers; single or bulk grading via Celery async queue; toggleable by superadmin
- **Login brute-force protection** — 5 failed attempts per IP triggers a 15-minute lockout
- **Dark mode** — system-wide theme toggle via CSS custom properties; all interactive states (MCQ selection, correct-answer badges) adapt to dark backgrounds
- **Force password change** — admin-created teacher accounts require password change on first login

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go 1.25, Fiber v2.52, GORM v1.25, PostgreSQL 16 |
| Auth | golang-jwt/jwt v5, bcrypt cost 12 |
| Code execution | Docker SDK v26, ephemeral sibling containers |
| Video proctoring | Native WebRTC + WebSocket signaling (star topology) |
| PDF (backend) | go-pdf/fpdf v0.9 (fallback reports) |
| Frontend | React 18, TypeScript 5.4, Vite 5.3, Axios 1.7 |
| PDF (frontend) | jsPDF 2.5 + jsPDF-autotable 3.8, JSZip 3.10 |
| Serving | Nginx 1.25-alpine (SPA + reverse proxy) |
| LLM grading | Python 3.11, FastAPI, llama-cpp-python, Celery + Redis |
| Orchestration | Docker Compose |

## Getting Started

### Prerequisites

- Docker and Docker Compose
- `git`

### Setup

```bash
git clone <repo-url>
cd exam-portal

cp .env.example .env
# Edit .env and fill in DB_PASSWORD, JWT_SECRET, and optionally ADMIN_EMAIL / ADMIN_PASSWORD
```

Find your Docker socket GID (needed for the code execution sandbox):

```bash
stat -c '%g' /var/run/docker.sock
# Set the output as DOCKER_GID in .env
```

### Run

```bash
docker compose up --build
```

- Frontend: http://localhost:9999
- Backend API: http://localhost:8080
- LLM Service: http://localhost:8000

On first startup the database schema is created automatically. If `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set in `.env`, a superadmin account is bootstrapped. The superadmin can then create teacher accounts via the admin panel.

## Project Structure

```
backend/
  config/         env var loading (DATABASE_URL, JWT_SECRET, PORT)
  crypto/         AES-256-GCM helpers for encrypting credentials at rest
  database/       GORM init + AutoMigrate (FK order matters)
  handlers/       one file per resource; all share a *Handler receiver
    room.go       WebRTC room/participant management
    webrtc.go     WebSocket upgrade middleware for signaling
    mail.go       SMTP settings + report sending + backend PDF fallback
    feedback.go   teacher feedback CRUD
    llm_grader.go single + bulk AI auto-grading orchestration
    settings.go   platform-wide feature flag endpoints
  middleware/     JWT validation + role extraction
  models/         GORM structs — source of truth for DB schema
    feedback.go   feedback types: bug, suggestion, usability, performance, other
    settings.go   single-row AppSettings for feature flags (e.g., LLM toggle)
  routes/         public / JWT-protected / admin route groups
  runner/         Docker sandbox manager (security-sensitive)
  seed/           superadmin bootstrap on startup
  uploads/        profile picture files (served at /uploads)

llm-service/
  main.py         FastAPI app — /grade (sync), /grade/batch + /grade/status (Celery async)
  tasks.py        Celery worker — loads own model copy, concurrency=1
  Dockerfile      Builds llama-cpp-python with CPU support

frontend/src/
  api/client.ts         single Axios instance + all TypeScript interfaces + API helpers
  pages/
    Dashboard.tsx       teacher exam list
    ExamCreate.tsx      new exam form
    ExamEdit.tsx        edit existing exam
    ExamView.tsx        exam detail — questions, submissions, analytics tabs
    ExamMonitor.tsx     live WebRTC video monitoring during exam
    GradingView.tsx     grade individual submissions
    StudentExam.tsx     student exam session — fullscreen lockdown, violation tracking, proctoring
    ExamLobby.tsx       student browse active exams
    AdminStaff.tsx      superadmin teacher management
    AdminFeedback.tsx   superadmin feedback review panel
  components/
    Navbar.tsx          sticky navigation bar with profile menu
    ProtectedRoute.tsx  JWT auth gate + force-password-change redirect
    TeacherLayout.tsx   layout wrapper with floating feedback button
    DraggableCamera.tsx floating student camera preview with device controls
    FeedbackModal.tsx   teacher feedback submission form
  contexts/
    ThemeContext.tsx     light/dark mode via CSS vars + data-theme attribute
  hooks/
    useWebRTC.ts        WebRTC peer connections, WebSocket signaling, track management
  utils/
    generateStudentPDF.ts  rich PDF for download and email attachment
```

## API Overview

Full route list in `routes/routes.go`. Three auth levels:

| Group | Routes |
|-------|--------|
| Public | `POST /api/auth/login`, `GET /api/exams/active`, `POST /api/exams/:id/verify-pin`, `POST /api/exams/:id/join`, `POST /api/exams/:id/submit`, `GET /api/exams/:id/public`, `POST /api/exams/:id/execute` |
| JWT (teacher) | `/api/exams` CRUD, `/api/question-sets` CRUD, `/api/questions` CRUD, `/api/submissions` read/grade/delete/import, `/api/exams/:id/analytics`, `/api/exams/:id/upload-questions`, `/api/reports/send/:id`, `/api/reports/send-all`, `/api/execute`, `/api/me`, `/api/me/profile-pic`, `/api/me/mail-settings`, `/api/feedback`, `GET /api/settings`, `/api/llm/health`, `/api/submissions/:id/auto-grade`, `/api/exams/:id/auto-grade-all` |
| JWT (superadmin) | `/api/admin/teachers` CRUD + reset-password + activate/deactivate, `/api/admin/feedback` list + delete, `/api/admin/teachers/:id/exams`, `PATCH /api/admin/settings` |
| WebSocket | `/api/ws` — WebRTC signaling + chat for video proctoring rooms |

Student submissions (`POST /api/exams/:id/submit`) require no auth — name + email in body.

## Frontend Routes

| Path | Page | Access |
|------|------|--------|
| `/` | Landing page | Public |
| `/exams` | Exam lobby (student) | Public |
| `/take/:id` | Student exam session | Public (PIN-verified) |
| `/login` | Teacher login | Public |
| `/dashboard` | Teacher dashboard | JWT |
| `/exams/new` | Create exam | JWT |
| `/exams/:id` | Exam detail (questions/submissions/analytics) | JWT |
| `/exams/:id/edit` | Edit exam | JWT |
| `/exams/:id/monitor` | Live video proctoring monitor | JWT |
| `/exams/:examId/grade/:submissionId` | Grade submission | JWT |
| `/force-password-change` | First-login password change | JWT |
| `/admin/manage-staff` | Teacher management | Superadmin |
| `/admin/feedback` | Feedback review | Superadmin |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DB_PASSWORD` | PostgreSQL password |
| `JWT_SECRET` | Secret for signing JWT tokens and deriving the credential encryption key (min 32 chars) |
| `DOCKER_GID` | GID of the Docker socket group (default: 999) |
| `ADMIN_EMAIL` | Superadmin email for bootstrap (optional) |
| `ADMIN_PASSWORD` | Superadmin password for bootstrap (optional) |
| `LLM_SERVICE_URL` | URL of the LLM grading service (default: `http://llm-service:8000`) |

## Local Development

**Backend only:**

```bash
cd backend
go run .
```

**Frontend only** (proxies `/api` to `localhost:8080`):

```bash
cd frontend
npm install
npm run dev
```

**Type-check frontend:**

```bash
cd frontend
npx tsc --noEmit
```

**Rebuild a single service:**

```bash
docker compose build backend
docker compose build frontend
```

## Security Notes

- Code execution containers: `NetworkMode: none`, 64 MB memory, 50 PID limit, read-only rootfs, `no-new-privileges`, code delivered via stdin (not env vars), tmpfs `/tmp` with `exec` flag for compiled binaries
- Login rate-limited: 5 failed attempts per IP → 15-minute lockout (in-memory)
- Correct answers never exposed in public/student-facing API responses
- Ownership verified via SQL joins before every mutating operation — failures return 404 to avoid leaking resource existence
- SMTP app passwords encrypted with AES-256-GCM before storage; key derived from `JWT_SECRET`
- Offline submission backups are SHA-256 tamper-checked before import
- Nginx enforces `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and a strict Content Security Policy
- WebRTC star topology prevents student-to-student connections; signaling via WebSocket

## Documentation

| Topic | File |
|-------|------|
| Architectural patterns & conventions | `.claude/docs/architectural_patterns.md` |
| Comprehensive project documentation | `docs/PROJECT_DOCUMENTATION.md` |
