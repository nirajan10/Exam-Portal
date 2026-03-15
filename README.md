# Exam Portal

A secure online exam platform where teachers create and manage exams with MCQ, code execution, and theory questions. Students join anonymously; coding answers run inside isolated Docker sandboxes. Graded reports are emailed to students as PDF attachments.

## Features

- **Multiple question types** — MCQ, MRQ (multi-select), code execution, and free-text theory
- **Isolated code execution** — student code runs in ephemeral Docker containers with no network, limited memory, and a PID cap
- **Role-based access** — superadmin, teacher, and anonymous student tiers
- **Live proctoring** — optional webcam feed, fullscreen enforcement, and violation limits
- **Question sets** — randomized sets so each student receives a different variant of the exam
- **Analytics & grading** — per-question score distributions, manual grading for theory/code answers, bulk ZIP export of PDF reports
- **Email reports** — teachers send graded PDF reports directly to students via their own Gmail SMTP credentials (BYOM)
- **Bulk import** — CSV upload for creating questions in bulk
- **Offline submission backup** — students can download an encrypted backup of their answers; teachers can reimport it if connectivity is lost
- **PIN-protected exams** — optional access code required to join
- **Teacher profiles** — profile picture upload, display name

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go 1.25, Fiber v2.52, GORM v1.25, PostgreSQL 16 |
| Auth | golang-jwt/jwt v5, bcrypt cost 12 |
| Code execution | Docker SDK v26, ephemeral sibling containers |
| PDF (backend) | go-pdf/fpdf v0.9 |
| Frontend | React 18, TypeScript 5.4, Vite 5.3, Axios 1.7 |
| PDF (frontend) | jsPDF 2.5, jsPDF-autotable 3.8, JSZip 3.10 |
| Serving | Nginx 1.25-alpine (SPA + reverse proxy) |
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

On first startup the database schema is created automatically. If `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set in `.env`, a superadmin account is bootstrapped. The superadmin can then create teacher accounts via the admin panel.

## Project Structure

```
backend/
  config/         env var loading (DATABASE_URL, JWT_SECRET, PORT)
  crypto/         AES-256-GCM helpers for encrypting credentials at rest
  database/       GORM init + AutoMigrate
  handlers/       one file per resource; all share a *Handler receiver
  middleware/     JWT validation + role extraction
  models/         GORM structs — source of truth for DB schema
  routes/         public vs. JWT-protected route split
  runner/         Docker sandbox manager (security-sensitive)
  seed/           superadmin bootstrap on startup
  uploads/        profile picture files (served at /uploads)

frontend/src/
  api/client.ts   single Axios instance + all TypeScript interfaces + API helpers
  pages/          route-level components (one per page)
  components/     shared UI — Navbar, ProtectedRoute, TeacherLayout, ProfileModal
  contexts/       ThemeContext (light/dark mode)
  utils/          generateStudentPDF.ts — rich PDF for download and email attachment
```

## API Overview

| Visibility | Routes |
|-----------|--------|
| Public | `POST /api/auth/login` |
| Public (student) | `GET /api/exams/active`, `POST /api/exams/:id/verify-pin`, `POST /api/exams/:id/join`, `POST /api/exams/:id/submit`, `GET /api/exams/:id/public`, `POST /api/exams/:id/execute` |
| JWT (teacher) | `/api/exams` CRUD, `/api/question-sets` CRUD, `/api/questions` CRUD, `/api/submissions` (read/grade/delete), `/api/exams/:id/analytics`, `/api/exams/:id/upload-questions`, `/api/submissions/import`, `/api/reports/send/:id`, `/api/reports/send-all`, `/api/execute`, `/api/me`, `/api/me/mail-settings` |
| JWT (superadmin) | `/api/admin/teachers` CRUD + reset-password + activate/deactivate |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DB_PASSWORD` | PostgreSQL password |
| `JWT_SECRET` | Secret for signing JWT tokens and deriving the credential encryption key (min 32 chars) |
| `DOCKER_GID` | GID of the Docker socket group (default: 999) |
| `ADMIN_EMAIL` | Superadmin email for bootstrap (optional) |
| `ADMIN_PASSWORD` | Superadmin password for bootstrap (optional) |

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

**Rebuild a single service:**

```bash
docker compose build backend
docker compose build frontend
```

## Security Notes

- Code execution containers run with `NetworkMode: none`, 64 MB memory limit, 50 PID limit, and a read-only root filesystem
- Correct answers are never exposed in public/student-facing API responses
- Ownership is verified via SQL joins before every mutating operation — failures return 404 to avoid leaking resource existence
- SMTP app passwords are encrypted with AES-256-GCM before storage; the key is derived from `JWT_SECRET`
- Offline submission backups are SHA-256 tamper-checked before import
- Nginx enforces `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and a strict Content Security Policy
