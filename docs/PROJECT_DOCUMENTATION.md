# Exam Portal — Project Documentation

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Project Structure](#3-project-structure)
4. [Architecture & Data Flow](#4-architecture--data-flow)
5. [Setup & Installation](#5-setup--installation)
6. [Usage Guide](#6-usage-guide)
7. [API Documentation](#7-api-documentation)
8. [Key Components Deep Dive](#8-key-components-deep-dive)
9. [Dependencies](#9-dependencies)
10. [Improvements & TODOs](#10-improvements--todos)

---

## 1. Project Overview

### What It Does

Exam Portal is a self-hosted online exam platform for educational institutions. Teachers create exams with multiple question types, students take them in a secure browser environment, and teachers grade and deliver results via email — all without students needing accounts.

### Key Features

- **Multiple question types** — MCQ, MRQ (multiple response), code execution, and theory/essay
- **Secure code execution** — Student code runs in isolated Docker containers with no network, memory caps, and process limits
- **Live video proctoring** — WebRTC-based camera monitoring with star topology (teacher sees all students, students don't see each other)
- **Fullscreen lockdown** — Violation tracking for tab switching, window opening, fullscreen exit, and paste attempts
- **Automated grading** — MCQ/MRQ auto-graded on submit; theory and code graded manually by teacher
- **PDF reports** — Rich browser-generated reports emailed to students via teacher's own Gmail SMTP
- **Question set randomization** — Multiple question sets per exam; students deterministically assigned to a set
- **Offline backup** — Students can download a tamper-detected backup file if connectivity drops
- **Camera proctoring** — Optional webcam requirement with device selection
- **Dark mode** — Full theme support across the platform

### Target Users

- **Teachers/Professors** — Create exams, monitor live sessions, grade submissions, send reports
- **Students** — Join exams via PIN, take exams in a proctored environment
- **Administrators** — Manage teacher accounts, review platform feedback

---

## 2. Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Backend** | Go 1.25, Fiber v2.52 | HTTP server, REST API |
| **ORM** | GORM v1.25 | Database modeling, migrations, queries |
| **Database** | PostgreSQL 16 | Primary data store |
| **Auth** | golang-jwt/jwt v5, bcrypt (cost 12) | Token-based authentication |
| **Code Sandbox** | Docker SDK v26 | Ephemeral container execution |
| **PDF (backend)** | go-pdf/fpdf v0.9 | Fallback report generation |
| **Encryption** | AES-256-GCM (stdlib) | SMTP credential encryption at rest |
| **Frontend** | React 18, TypeScript 5.4 | SPA user interface |
| **Build Tool** | Vite 5.3 | Frontend bundling and dev server |
| **HTTP Client** | Axios 1.7 | API communication |
| **PDF (frontend)** | jsPDF 2.5 + jsPDF-autotable 3.8 | Rich student report generation |
| **Charts** | Recharts 2.12 | Analytics visualization |
| **Routing** | React Router DOM 6.24 | Client-side routing |
| **Video** | Native WebRTC + WebSocket | Live camera proctoring |
| **Reverse Proxy** | Nginx 1.25-alpine | SPA serving, API proxy, WebSocket upgrade |
| **Orchestration** | Docker Compose | Multi-service deployment |

---

## 3. Project Structure

```
Exam-Portal/
├── .env.example                    # Environment variable template
├── docker-compose.yml              # Service orchestration (db, backend, frontend)
├── CLAUDE.md                       # AI assistant project context
│
├── backend/
│   ├── Dockerfile                  # Multi-stage Go build → alpine runtime
│   ├── main.go                     # Entry point: config, DB, runner, Fiber app
│   ├── go.mod / go.sum             # Go module dependencies
│   │
│   ├── config/
│   │   └── config.go               # Env var loading (DATABASE_URL, JWT_SECRET, etc.)
│   │
│   ├── crypto/
│   │   └── aes.go                  # AES-256-GCM encrypt/decrypt; key derived from JWT_SECRET
│   │
│   ├── database/
│   │   └── database.go             # GORM init, AutoMigrate (FK-ordered), schema cleanup
│   │
│   ├── middleware/
│   │   └── jwt.go                  # JWT validation, ExtractTeacherID, RequireRole
│   │
│   ├── models/                     # GORM entity definitions (source of truth for DB schema)
│   │   ├── teacher.go              # Teacher accounts + SMTP credentials
│   │   ├── exam.go                 # Exam config, timing, proctoring settings
│   │   ├── question_set.go         # Question grouping for randomization
│   │   ├── question.go             # MCQ/MRQ/code/theory with typed enums
│   │   ├── submission.go           # Student attempt + per-answer breakdown
│   │   └── feedback.go             # Teacher feedback (bug, suggestion, etc.)
│   │
│   ├── handlers/                   # HTTP handlers (one file per resource)
│   │   ├── handler.go              # Handler struct (DI container): db, runner, cfg, RoomHub
│   │   ├── auth.go                 # Login, password update, register (disabled)
│   │   ├── admin.go                # Superadmin teacher CRUD
│   │   ├── exam.go                 # Exam CRUD + public view + timing/expiry
│   │   ├── question_set.go         # QuestionSet CRUD + duplicate
│   │   ├── question.go             # Question CRUD with transitive ownership checks
│   │   ├── submission.go           # Submit, grade, analytics, offline import
│   │   ├── join.go                 # Deterministic session ID + set assignment
│   │   ├── execute.go              # Code execution dispatch (student + teacher modes)
│   │   ├── mail.go                 # SMTP settings, report sending, bulk send-all
│   │   ├── teacher.go              # Profile update, profile picture upload
│   │   ├── upload.go               # CSV bulk question upload with fail-fast validation
│   │   ├── feedback.go             # Teacher feedback create, admin list/delete
│   │   ├── room.go                 # WebRTC signaling room management
│   │   └── webrtc.go               # WebSocket upgrade middleware
│   │
│   ├── routes/
│   │   └── routes.go               # Route registration: public / protected / admin groups
│   │
│   ├── runner/
│   │   └── runner.go               # Docker sandbox: container config, security, execution
│   │
│   ├── seed/
│   │   └── seed.go                 # Superadmin bootstrap on startup
│   │
│   └── uploads/
│       └── profile_pics/           # Teacher profile picture storage
│
├── frontend/
│   ├── Dockerfile                  # Multi-stage Node build → Nginx runtime
│   ├── nginx.conf                  # SPA routing, /api proxy, /api/ws WebSocket proxy
│   ├── package.json                # NPM dependencies
│   ├── tsconfig.json               # TypeScript config (strict mode)
│   ├── vite.config.ts              # Vite dev server + proxy
│   │
│   └── src/
│       ├── main.tsx                # React entry point
│       ├── App.tsx                 # Route definitions (public, teacher, admin)
│       ├── index.css               # CSS variables for theme (light/dark)
│       │
│       ├── api/
│       │   └── client.ts           # Axios instance, token mgmt, all API helpers + TS interfaces
│       │
│       ├── components/
│       │   ├── Navbar.tsx           # Top nav with avatar dropdown, role-aware links
│       │   ├── ProtectedRoute.tsx   # JWT guard + force-password-change redirect
│       │   ├── TeacherLayout.tsx    # Navbar + Outlet wrapper + floating feedback button
│       │   ├── ProfileModal.tsx     # Teacher profile editor
│       │   ├── FeedbackModal.tsx    # Feedback submission form (type selector + description)
│       │   ├── DraggableCamera.tsx  # Floating camera preview with audio/video toggles
│       │   ├── ChatPanel.tsx        # WebRTC text chat sidebar
│       │   └── DeviceSelector.tsx   # Camera/mic device picker with audio level meter
│       │
│       ├── contexts/
│       │   └── ThemeContext.tsx     # Dark mode via data-theme attribute + CSS variables
│       │
│       ├── hooks/
│       │   └── useWebRTC.ts        # WebRTC peer connections, signaling, track management
│       │
│       ├── pages/
│       │   ├── LandingPage.tsx     # Public homepage
│       │   ├── Login.tsx           # Teacher login form
│       │   ├── ForcePasswordChange.tsx  # Mandatory password reset for new accounts
│       │   ├── Dashboard.tsx       # Teacher exam list with live countdown timers
│       │   ├── ExamCreate.tsx      # New exam form
│       │   ├── ExamEdit.tsx        # Edit exam settings
│       │   ├── ExamView.tsx        # Main exam editor (questions, submissions, analytics tabs)
│       │   ├── GradingView.tsx     # Grade individual submission with per-answer scoring
│       │   ├── ResultsAnalytics.tsx # Exam statistics with Recharts visualizations
│       │   ├── ExamMonitor.tsx     # Live video proctoring dashboard (teacher)
│       │   ├── ExamLobby.tsx       # Public exam list for students
│       │   ├── StudentJoin.tsx     # Legacy student entry point
│       │   ├── StudentExam.tsx     # Full exam session (questions, timer, proctoring, violations)
│       │   ├── AdminStaff.tsx      # Superadmin teacher management
│       │   └── AdminFeedback.tsx   # Superadmin feedback review with type filtering
│       │
│       └── utils/
│           └── generateStudentPDF.ts  # jsPDF report with score cards, progress bars, breakdown
│
└── .claude/
    └── docs/
        └── architectural_patterns.md  # 19 documented patterns for contributors
```

---

## 4. Architecture & Data Flow

### High-Level Architecture

```
                    ┌──────────────────────────────────┐
                    │          Docker Compose           │
                    │                                   │
  Student/Teacher   │   ┌───────────┐   ┌──────────┐  │
  Browser ──────────┼──►│  Nginx    │──►│  Go API  │  │
  (React SPA)       │   │  :9999    │   │  :8080   │  │
                    │   └───────────┘   └────┬─────┘  │
                    │        │               │         │
                    │   SPA + Proxy     ┌────▼─────┐   │
                    │   /api → backend  │ Postgres │   │
                    │   /api/ws → WS    │  :5432   │   │
                    │                   └──────────┘   │
                    │                        │         │
                    │               ┌────────▼───────┐ │
                    │               │ Docker Socket  │ │
                    │               │ (code sandbox) │ │
                    │               └────────────────┘ │
                    └──────────────────────────────────┘
```

### Request Flow

**Teacher creates exam:**
```
Browser → POST /api/exams (JWT) → Fiber handler → ExtractTeacherID → GORM Create → PostgreSQL
```

**Student takes exam:**
```
1. Browser → GET /api/exams/active → List active exams
2. Browser → POST /api/exams/:id/verify-pin → Validate PIN
3. Browser → POST /api/exams/:id/join → Get session ID + question set (HMAC-deterministic)
4. Browser → GET /api/exams/:id/public → Get questions (hidden during buffer)
5. Browser → POST /api/exams/:id/execute → Run code in Docker sandbox
6. Browser → POST /api/exams/:id/submit → Submit answers (MCQ auto-graded in transaction)
```

**Video proctoring:**
```
1. Student/Teacher → WebSocket /api/ws → join room
2. Server sends participant-list → new joiner sends WebRTC offers to existing peers
3. Star topology: students connect ONLY to teacher (never to each other)
4. ICE candidates + SDP exchanged via WebSocket signaling
5. Audio/video streams flow over peer-to-peer WebRTC connections
```

**Grading & reports:**
```
1. Teacher opens submission → PATCH /api/submissions/:id/grade (scores + feedback per answer)
2. Frontend generates rich PDF via jsPDF → base64 encoded
3. POST /api/reports/send/:id with { pdf_data: "<base64>" }
4. Backend decrypts teacher's SMTP credentials (AES-256-GCM)
5. Sends email with PDF attachment via Gmail SMTP
```

### Data Model Relationships

```
Teacher (1) ──► (N) Exam (1) ──► (N) QuestionSet (1) ──► (N) Question
                    │
                    └──► (N) Submission (1) ──► (N) SubmissionAnswer ──► Question

Teacher (1) ──► (N) Feedback
```

### Exam Timeline

```
Teacher activates exam
       │
       ▼
T0 = started_at
       │
       ├── Buffer Period (optional, questions hidden)
       │
T1 = T0 + buffer_duration_mins
       │
       ├── Exam Period (questions visible, timer running)
       │
T2 = T1 + duration_minutes
       │
       ├── Grace Period (2 min, late submissions accepted)
       │
T3 = T2 + 2 min
       │
       └── Exam auto-deactivated (lazy check on next access)
```

---

## 5. Setup & Installation

### Prerequisites

- Docker and Docker Compose
- Git

### Quick Start

```bash
# 1. Clone the repository
git clone <repo-url>
cd Exam-Portal

# 2. Create environment file
cp .env.example .env
```

### Environment Variables

Edit `.env` with your values:

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_PASSWORD` | Yes | PostgreSQL password |
| `JWT_SECRET` | Yes | JWT signing key (minimum 32 characters) |
| `DOCKER_GID` | Yes | Docker socket group ID (run `stat -c '%g' /var/run/docker.sock`) |
| `ADMIN_EMAIL` | No | Superadmin email (bootstrapped on first start) |
| `ADMIN_PASSWORD` | No | Superadmin password |

```bash
# 3. Start all services
docker compose up --build

# 4. Access the application
# Frontend: http://localhost:9999
# Backend API: http://localhost:8080/api
```

### Development Mode

```bash
# Backend (requires Go 1.25+, PostgreSQL running)
cd backend
go build ./...
go run .

# Frontend (proxies /api to localhost:8080)
cd frontend
npm install
npm run dev          # Dev server at http://localhost:5173

# Type-check only
npx tsc --noEmit
```

### Rebuilding Individual Services

```bash
docker compose build backend
docker compose build frontend
docker compose up -d backend   # restart just backend
```

---

## 6. Usage Guide

### Admin Workflow

1. Log in with superadmin credentials (bootstrapped from env vars)
2. Navigate to **Staff Management** to create teacher accounts
3. Teachers receive a temporary password and must change it on first login
4. Review teacher **Feedback** from the admin nav

### Teacher Workflow

1. Log in → **Dashboard** shows all your exams
2. **Create Exam** → Set title, duration, question types, proctoring settings
3. Add **Question Sets** (students are randomly assigned to one)
4. Add **Questions** to each set (MCQ, MRQ, code, theory)
5. Set a **Login Code** (PIN) and **Activate** the exam
6. Share the PIN with students
7. **Monitor** the live exam via the video proctoring dashboard
8. After the exam, go to **Submissions** tab to grade theory/code questions
9. **Send Reports** individually or in bulk via email

### Student Workflow

1. Go to the **Exam Lobby** (public page)
2. Enter the exam **PIN** provided by the teacher
3. Enter **name and email** to join
4. If camera proctoring is enabled, grant camera/mic access
5. Wait through **buffer period** (if any) — exam enters fullscreen
6. Answer questions within the time limit
7. For code questions, write and **Run** code (limited executions)
8. **Submit** when done — MCQ/MRQ scored instantly
9. Download a **backup file** if connectivity is unstable

### Violation Rules (Fullscreen Exams)

| Action | Result |
|--------|--------|
| Switch tab | Violation (visibilitychange) |
| Open new window | Violation (blur) |
| Exit fullscreen | 5-second grace → violation every 2 seconds |
| Paste text | Violation |
| Click anywhere while not fullscreen | Auto re-enters fullscreen |
| Reach violation limit | Auto-submission |

---

## 7. API Documentation

### Authentication

All teacher endpoints require a JWT token in the `Authorization: Bearer <token>` header.

Student endpoints (under `/api/exams/:id/...`) require no authentication.

### Public Endpoints

#### `POST /api/auth/login`
Authenticate a teacher.
```json
// Request
{ "email": "teacher@example.com", "password": "secret" }

// Response 200
{ "token": "eyJhbG...", "teacher": { "id": 1, "name": "Jane", "email": "...", "role": "teacher" } }
```

#### `GET /api/exams/active`
List all active exams (student lobby).
```json
// Response 200
[{ "id": 1, "title": "Midterm CS101", "camera_proctoring_required": true, "login_code_required": true }]
```

#### `POST /api/exams/:id/verify-pin`
Verify exam PIN.
```json
// Request
{ "login_code": "1234" }

// Response 200
{ "valid": true }
```

#### `POST /api/exams/:id/join`
Join exam and receive session assignment.
```json
// Request
{ "student_name": "Alice", "student_email": "alice@uni.edu" }

// Response 200
{ "session_id": "STU-A3F2B1C0", "assigned_set_id": 42 }
```

#### `POST /api/exams/:id/submit`
Submit all answers at once.
```json
// Request
{
  "session_id": "STU-A3F2B1C0",
  "student_name": "Alice",
  "student_email": "alice@uni.edu",
  "answers": [
    { "question_id": 1, "answer": "B" },
    { "question_id": 2, "answer": "print('hello')" }
  ]
}

// Response 201
{ "id": 10, "total_score": 15.0, "status": "pending_grading" }
```

#### `POST /api/exams/:id/execute`
Run student code in sandbox (respects `max_code_runs`).
```json
// Request
{ "language": "python", "code": "print('hello')" }

// Response 200
{ "stdout": "hello\n", "stderr": "", "exit_code": 0, "timed_out": false }
```

### Teacher Endpoints (JWT Required)

#### Exams
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/exams` | List teacher's exams |
| `POST` | `/api/exams` | Create exam |
| `GET` | `/api/exams/:id` | Get exam with question sets |
| `PUT` | `/api/exams/:id` | Update exam |
| `PATCH` | `/api/exams/:id/status` | Activate/deactivate exam |
| `DELETE` | `/api/exams/:id` | Delete exam (cascades) |

#### Questions & Sets
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/question-sets` | Create question set |
| `PUT` | `/api/question-sets/:id` | Update question set |
| `DELETE` | `/api/question-sets/:id` | Delete question set |
| `POST` | `/api/question-sets/:id/duplicate` | Clone set with questions |
| `POST` | `/api/questions` | Create question |
| `PUT` | `/api/questions/:id` | Update question |
| `DELETE` | `/api/questions/:id` | Delete question |

#### Submissions & Grading
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/submissions?exam_id=X` | List submissions for exam |
| `GET` | `/api/submissions/:id` | Get submission with answers |
| `PATCH` | `/api/submissions/:id/grade` | Grade answers (scores + feedback) |
| `DELETE` | `/api/submissions/:id` | Delete submission |
| `POST` | `/api/submissions/import` | Import offline backup |

#### Reports & Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/reports/send/:id` | Email report to student |
| `POST` | `/api/reports/send-all` | Bulk email all graded (async) |
| `GET` | `/api/exams/:id/analytics` | Score distribution, per-question stats |

#### Profile & Settings
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/me` | Get current teacher profile |
| `POST` | `/api/me/profile-pic` | Upload profile picture |
| `GET` | `/api/me/mail-settings` | Get SMTP config (no password) |
| `PUT` | `/api/me/mail-settings` | Save SMTP credentials (encrypted) |
| `POST` | `/api/me/mail-settings/test` | Send test email |
| `POST` | `/api/feedback` | Submit platform feedback |

#### Code Execution (Teacher)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/execute` | Run code with custom stdin |

### Superadmin Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/admin/teachers` | List all teachers |
| `POST` | `/api/admin/create-teacher` | Create teacher (returns temp password) |
| `PATCH` | `/api/admin/teachers/:id/reset-password` | Reset password |
| `PATCH` | `/api/admin/teachers/:id/active` | Activate/deactivate |
| `DELETE` | `/api/admin/teachers/:id` | Delete teacher |
| `GET` | `/api/admin/teachers/:id/exams` | List teacher's exams |
| `GET` | `/api/admin/feedback` | List all feedback |
| `DELETE` | `/api/admin/feedback/:id` | Delete feedback entry |

---

## 8. Key Components Deep Dive

### 8.1 Docker Code Sandbox (`backend/runner/runner.go`)

The most security-sensitive part of the system. Executes untrusted student code in ephemeral Docker containers.

**Security constraints applied to every container:**

| Constraint | Value | Purpose |
|-----------|-------|---------|
| Network | `none` | No internet access |
| Memory | 64 MB (no swap) | Prevent memory bombs |
| CPU | 0.5 cores | Fair resource sharing |
| Process limit | 50 | Prevent fork bombs |
| Root filesystem | Read-only | No persistent writes |
| Writable space | `/tmp` (10 MB tmpfs) | Scratch space for compilation |
| Privileges | `no-new-privileges` | No privilege escalation |
| Timeout | 15 seconds hard limit | Prevent infinite loops |

**Execution flow:**
1. Select Docker image based on language (`gcc:latest` for C/C++, `python:3.12-alpine` for Python)
2. Create container with security constraints
3. Attach stdin/stdout/stderr
4. Start container, write code via stdin in a goroutine
5. Read output using Docker's multiplexed stream (`stdcopy.StdCopy`)
6. Force-kill on timeout, always cleanup via `defer` with fresh context

**Two execution modes:**
- **Stdin mode** (students): Code delivered via stdin; no custom program input
- **Embed mode** (teachers): Code base64-embedded in command; stdin available for program input

### 8.2 Deterministic Session Assignment (`backend/handlers/join.go`)

Students don't have accounts, so session identity must be reproducible:

```
digest = HMAC-SHA256(JWT_SECRET, "examId|studentEmail")
session_id = "STU-" + hex(digest[0:4]).upper()     // e.g., "STU-A3F2B1C0"
set_index  = uint32(digest[4:8]) % len(questionSets)
```

This ensures:
- Same student always gets the same session ID (safe to rejoin/refresh)
- Same student always gets the same question set
- Different students get different sets (distributed by HMAC)
- No server-side session state needed

### 8.3 WebRTC Video Proctoring (`frontend/src/hooks/useWebRTC.ts`)

**Star topology architecture:**
```
           Teacher
          /   |   \
    Student Student Student
    (no direct connections between students)
```

- Students only create peer connections to teachers, ignoring offers from other students
- Prevents N-fold audio echo and reduces signaling complexity
- Both teacher and student send all tracks (audio + video) through a single stream per peer
- Browser echo cancellation (`echoCancellation: true`) handles acoustic feedback
- Audio played via hidden `<audio>` elements (separate from `<video muted>`) for browser AEC to work

**Signaling protocol (WebSocket JSON messages):**

| Message | Direction | Purpose |
|---------|-----------|---------|
| `join` | Client → Server | Join room with name and role |
| `participant-list` | Server → Client | Existing participants on join |
| `participant-joined` | Server → Clients | New participant notification |
| `offer` / `answer` | Peer → Peer (via server) | SDP exchange |
| `ice-candidate` | Peer → Peer (via server) | ICE candidate exchange |
| `chat` | Client ↔ Server | Text messages |
| `kick-student` | Teacher → Student (via server) | Remove student from exam |

### 8.4 Exam Violation System (`frontend/src/pages/StudentExam.tsx`)

Multi-layered detection with deduplication:

1. **`visibilitychange`** — Tab becomes hidden (alt-tab, new tab)
2. **`blur`** — Window loses focus (new window, Ctrl+N)
3. **`fullscreenchange`** — Exits fullscreen (Esc key)
4. **`paste`** — Clipboard paste blocked and logged

**Deduplication:** A tab switch fires both `visibilitychange` and `blur`. A 500ms timestamp guard ensures only one violation is counted.

**Fullscreen exit flow:**
```
Exit fullscreen → 5s countdown (grace period, no violation)
                  ↓ (if not returned)
                  First violation recorded
                  ↓
                  Every 2 seconds: another violation
                  ↓ (when limit reached)
                  Auto-submit exam
```

**Auto-recovery:** Any click while not in fullscreen silently re-enters fullscreen (works because `requestFullscreen()` requires a user gesture, and clicks qualify).

### 8.5 SMTP Credential Security (`backend/crypto/aes.go`)

Teachers store their Gmail app passwords for sending reports. These are encrypted at rest:

1. **Key derivation:** `SHA-256(JWT_SECRET)` → 32-byte AES key (no additional secret needed)
2. **Encryption:** AES-256-GCM with random 12-byte nonce per encryption
3. **Storage format:** `base64(nonce || ciphertext || auth_tag)`
4. **Decryption:** Extract nonce, authenticate via GCM tag, decrypt
5. **API safety:** Encrypted blob stored in `Teacher.SMTPAppPassword` (tagged `json:"-"`, never serialized)

### 8.6 Frontend Token Management (`frontend/src/api/client.ts`)

Dual-storage strategy for the JWT:

- **Module-scope variable** — Fast synchronous reads during the session
- **localStorage** — Survives page refresh

**Interceptors:**
- **Request:** Attaches `Authorization: Bearer <token>` to every request
- **Response:** Global 401 handler forces logout, except for student-facing paths (students don't have tokens)

**Teacher info cache:** Teacher profile stored in localStorage to populate the Navbar avatar without an extra API call.

### 8.7 PDF Report Generation

**Browser-side (rich):** `frontend/src/utils/generateStudentPDF.ts`
- Score summary card with percentage and color coding
- Progress bars for overall, MCQ, code, and theory sections
- Per-question breakdown table via jsPDF-autotable
- Code answers rendered in monospace blocks
- Used for: single-student download and email attachment

**Server-side (fallback):** `backend/handlers/mail.go:buildReportPDF`
- Simpler layout using go-pdf/fpdf
- Used for: bulk `send-all` (no browser context), or when browser PDF generation fails

**Flow:** Frontend generates PDF → base64-encodes → sends to `POST /reports/send/:id`. If `pdf_data` is missing, server generates its own.

---

## 9. Dependencies

### Backend (Go)

| Package | Version | Purpose |
|---------|---------|---------|
| `gofiber/fiber/v2` | 2.52.5 | HTTP framework (Express-like for Go) |
| `gorm.io/gorm` | 1.25.10 | ORM with migrations |
| `gorm.io/driver/postgres` | 1.5.9 | PostgreSQL driver for GORM |
| `golang-jwt/jwt/v5` | 5.2.1 | JWT creation and validation |
| `golang.org/x/crypto` | 0.24.0 | bcrypt password hashing |
| `docker/docker` | 26.1.4 | Docker SDK for container management |
| `go-pdf/fpdf` | 0.9.0 | PDF generation (fallback reports) |
| `google/uuid` | 1.6.0 | UUID generation |
| `joho/godotenv` | 1.5.1 | `.env` file loading |
| `gofiber/contrib/websocket` | 1.3.2 | WebSocket support for Fiber |

### Frontend (Node.js)

| Package | Version | Purpose |
|---------|---------|---------|
| `react` | 18.3.1 | UI framework |
| `react-dom` | 18.3.1 | React DOM renderer |
| `react-router-dom` | 6.24.0 | Client-side routing |
| `axios` | 1.7.2 | HTTP client with interceptors |
| `jspdf` | 2.5.1 | PDF generation in browser |
| `jspdf-autotable` | 3.8.2 | Table plugin for jsPDF |
| `jszip` | 3.10.1 | ZIP file creation (bulk downloads) |
| `recharts` | 2.12.7 | Chart components for analytics |
| `typescript` | 5.4.5 | Type safety |
| `vite` | 5.3.1 | Build tool and dev server |

---

## 10. Improvements & TODOs

### Missing Features

- **Real-time grading notifications** — Students don't know when their exam has been graded (no push notification or polling mechanism)
- **Question bank / reuse** — No way to share questions across exams; teachers must recreate or duplicate entire sets
- **Partial code grading** — Code questions require manual grading; automated test-case execution could score them
- **TURN server for WebRTC** — Only STUN servers configured (Google public); symmetric NAT environments may fail to connect without a TURN relay
- **Rate limiting** — No request rate limiting on public endpoints (login, join, submit); vulnerable to brute force
- **Audit logging** — No record of teacher actions (exam edits, grade changes, deletions)
- **Export results** — No CSV/Excel export for submission data
- **Email verification** — Student emails are self-reported and unverified

### Potential Optimizations

- **WebSocket connection pooling** — Each exam monitor creates individual WebSocket connections; consider multiplexing for large deployments
- **Database indexing** — Submission queries by `exam_id` + `student_email` could benefit from a composite index for large exam submissions
- **Image caching** — Docker images (`gcc:latest`, `python:3.12-alpine`) are pulled on every backend restart; pre-baked images in a local registry would speed cold starts
- **Lazy loading** — `ExamView.tsx` (81KB+) and `StudentExam.tsx` (94KB+) are very large single files; code splitting would improve initial load time
- **Pagination** — Submission list loads all submissions at once; pagination would help for exams with hundreds of students

### Code Quality Suggestions

- **Extract large page components** — `StudentExam.tsx` and `ExamView.tsx` contain many inline sub-components and 1000+ lines; extract into focused files
- **Global toast provider** — Toast notifications are reimplemented locally in each page; a context-based provider would reduce duplication
- **API error types** — Frontend catches errors with ad-hoc type casts (`err as { response?: ... }`); a typed error wrapper would improve reliability
- **Test coverage** — No automated tests exist (unit, integration, or e2e); adding tests for critical paths (submission, grading, code execution) would prevent regressions
- **WebSocket reconnection** — The WebRTC hook handles reconnection, but the signaling server has no room persistence; a brief network drop requires full renegotiation
