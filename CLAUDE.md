# Exam Portal

A secure online exam platform where teachers create exams (MCQ, code, theory). Students join without accounts; code questions run in isolated Docker sandboxes. Teachers send graded PDF reports via their own Gmail SMTP credentials.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go 1.25, Fiber v2.52, GORM v1.25, PostgreSQL 16 |
| Auth | golang-jwt/jwt v5, bcrypt cost 12 |
| Code execution | Docker SDK v26, ephemeral sibling containers |
| PDF (backend) | go-pdf/fpdf v0.9 (fallback reports) |
| Frontend | React 18, TypeScript 5.4, Vite 5.3, Axios 1.7 |
| PDF (frontend) | jsPDF 2.5 + jsPDF-autotable 3.8, JSZip 3.10 |
| Serving | Nginx 1.25-alpine (SPA + reverse proxy) |
| Orchestration | Docker Compose |

## Key Directories

```
backend/
  config/       env var loading — config.go:10-17
  crypto/       AES-256-GCM helpers for credentials at rest — aes.go
  database/     GORM init + AutoMigrate (FK order matters) — database.go:18-25
  models/       source of truth for DB schema
  handlers/     one file per resource; all share *Handler receiver
  middleware/   JWT validation + role extraction — jwt.go
  runner/       Docker sandbox — most security-sensitive code
  routes/       public / JWT-protected / admin split — routes.go
  seed/         superadmin bootstrap on startup — seed.go:15
  uploads/      profile pictures served as static files

frontend/src/
  api/client.ts     single Axios instance + all TS interfaces + API helpers
  pages/            route-level components (one per page)
  components/       Navbar, ProtectedRoute, TeacherLayout, ProfileModal
  contexts/         ThemeContext (light/dark)
  utils/            generateStudentPDF.ts — rich PDF used for download and email
```

## Build & Run

```bash
# Full stack
cp .env.example .env          # fill DB_PASSWORD, JWT_SECRET
docker compose up --build

# Backend only
cd backend && go build ./... && go run .

# Frontend only (proxies /api to localhost:8080)
cd frontend && npm install && npm run dev

# Rebuild one service
docker compose build backend
docker compose build frontend
```

## Essential Facts

- Frontend: **port 9999**, backend: **port 8080** (`docker-compose.yml:37,43`)
- Nginx proxies `/api/` → `backend:8080` — no CORS needed in production (`frontend/nginx.conf:17`)
- Body limit is **6 MB** to accommodate profile picture uploads (`main.go:33`)
- Backend mounts `/var/run/docker.sock` to spawn sandbox containers (`docker-compose.yml:30`)
- DB schema auto-migrates on every backend startup (`database/database.go:18`)
- Superadmin seeded from `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars (`seed/seed.go:15`); teachers are provisioned by admins only (`handlers/auth.go:14`)
- SMTP credentials (Gmail app passwords) are AES-256-GCM encrypted before storage, key derived from `JWT_SECRET` (`crypto/aes.go`, `handlers/mail.go:88`)
- Profile pictures stored at `./uploads/profile_pics/`, served at `/uploads` (`main.go:50`, `handlers/teacher.go:55-69`)

## API Surface

Full route list: `routes/routes.go`. Summary by auth level:

| Group | Representative routes |
|-------|-----------------------|
| Public | `POST /auth/login`, `GET /exams/active`, `GET /exams/:id/public`, `POST /exams/:id/verify-pin`, `POST /exams/:id/join`, `POST /exams/:id/submit`, `POST /exams/:id/execute`, `POST /submissions` |
| JWT-protected | `/exams` CRUD, `/question-sets` CRUD, `/questions` CRUD, `GET/PATCH/DELETE /submissions/:id`, `POST /submissions/import`, `GET /exams/:id/analytics`, `POST /exams/:id/upload-questions`, `GET+PUT /me/mail-settings`, `POST /me/mail-settings/test`, `POST /reports/send/:id`, `POST /reports/send-all`, `POST /execute`, `GET /me`, `POST /me/profile-pic` |
| Superadmin | `/admin/teachers` CRUD + reset-password + activate/deactivate + list exams |

Student submissions (`POST /exams/:id/submit`) require no auth — name + email in body.

## Additional Documentation

| Topic | File |
|-------|------|
| Architectural patterns, DI, ownership checks, API conventions, security invariants | `.claude/docs/architectural_patterns.md` |
