# Exam Portal

A secure online exam platform where teachers create exams with MCQ and coding questions. Students submit answers without auth; coding questions run in isolated Docker sandboxes.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go 1.25, Fiber v2.52, GORM v1.25, PostgreSQL 16 |
| Auth | golang-jwt/jwt v5, bcrypt cost 12 |
| Code execution | Docker SDK v26, ephemeral sibling containers |
| Frontend | React 18, TypeScript 5.4, Vite 5.3, Axios 1.7 |
| Serving | Nginx 1.25-alpine (SPA + reverse proxy) |
| Orchestration | Docker Compose |

## Key Directories

```
backend/
  config/       env var loading (DATABASE_URL, JWT_SECRET, PORT)
  database/     GORM init + AutoMigrate (order matters — see file)
  models/       GORM structs; source of truth for DB schema
  handlers/     one file per resource; all share *Handler receiver
  middleware/   JWT validation + role extraction
  runner/       Docker sandbox manager — most security-sensitive code
  routes/       public / JWT-protected / admin route split
  seed/         superadmin bootstrap on startup

frontend/src/
  api/client.ts single Axios instance + all TypeScript interfaces + API helpers
  pages/        route-level components (one per page)
  components/   shared UI (Navbar, ProtectedRoute, TeacherLayout)
  contexts/     ThemeContext (light/dark mode)
```

## Build & Run

```bash
# Full stack
cp .env.example .env          # fill DB_PASSWORD, JWT_SECRET
docker compose up --build

# Backend only (local)
cd backend && go build ./...
go run .

# Frontend only (local dev, proxies /api to localhost:8080)
cd frontend && npm install && npm run dev

# Rebuild a single service
docker compose build backend
docker compose build frontend
```

## Essential Facts

- Frontend is served on **port 9999** (`docker-compose.yml:43`)
- Backend API is on **port 8080** (`docker-compose.yml:37`)
- Nginx proxies `/api/` → `backend:8080` — no CORS needed in production (`frontend/nginx.conf:17`)
- Backend mounts `/var/run/docker.sock` to spawn code execution containers (`docker-compose.yml:30`)
- Superadmin bootstrapped from `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars at startup (`seed/seed.go:15`); teachers are created by admins, not self-registered (`handlers/auth.go:14`)
- DB schema auto-migrates on backend startup (`database/database.go:18`)

## API Surface

| Visibility | Routes |
|-----------|--------|
| Public | `POST /api/auth/login` |
| Public | `GET /api/exams/active`, `GET /api/exams/:id/public`, `POST /api/exams/:id/verify-pin`, `POST /api/exams/:id/join` |
| Public | `POST /api/submissions`, `POST /api/submissions/import`, `POST /api/execute/student` |
| JWT-protected | `/api/exams`, `/api/question-sets`, `/api/questions`, `/api/submissions` (GET/PATCH/DELETE), `/api/execute` |
| Admin-only | `/api/admin/teachers` (CRUD + password reset + activate/deactivate) |

Student answers submitted to `POST /api/submissions` require no auth — name + email provided in body.

## Additional Documentation

Check these files when working on the relevant areas:

| Topic | File |
|-------|------|
| Architectural patterns, DI, ownership checks, API conventions | `.claude/docs/architectural_patterns.md` |
