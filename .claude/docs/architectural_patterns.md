# Architectural Patterns

Patterns that appear across multiple files. Check the relevant section before adding new features.

---

## 1. Dependency Injection via Handler Struct

All HTTP handlers are methods on a single `*Handler` that holds shared dependencies.

- Struct + fields: `handlers/handler.go:9-14`
- Constructed once: `main.go:61`
- Every handler signature: `func (h *Handler) Name(c *fiber.Ctx) error`

Never pass `db`, `runner`, or `cfg` as function arguments — add to `Handler` if a new dependency is needed.

---

## 2. Ownership Authorization via SQL Join

Every mutating handler verifies the authenticated teacher owns the target resource. The join depth scales with nesting:

| Resource | Join strategy | File:Line |
|----------|--------------|-----------|
| Exam | `WHERE teacher_id = ?` | `handlers/exam.go:82-86` |
| QuestionSet | JOIN exams | `handlers/question_set.go:52-56` |
| Question | JOIN question_sets JOIN exams | `handlers/question.go:55-60` |
| Submission | JOIN exams | `handlers/submission.go:294-298` |
| Report send | JOIN exams | `handlers/mail.go:175-178` |

`middleware.ExtractTeacherID(c)` is called at the top of every protected handler (`middleware/jwt.go:22`). Ownership failures always return **404**, not 403, to avoid leaking resource existence.

---

## 3. Fiber Error Handling

All handlers return `fiber.NewError(statusCode, message)`. One global handler in `main.go:38-44` converts these to `{"error": "..."}` JSON. Never write inline `c.Status().JSON()` for error responses.

```
fiber.NewError(fiber.StatusBadRequest, "...")    → 400
fiber.NewError(fiber.StatusUnauthorized, "...")  → 401
fiber.NewError(fiber.StatusNotFound, "...")      → 404
fiber.NewError(fiber.StatusConflict, "...")      → 409
fiber.NewError(fiber.StatusGone, "...")          → 410 (expired exams)
```

---

## 4. GORM Model Conventions

Reference: `models/teacher.go`, `models/submission.go`, `models/question.go`

- PK: `ID uint \`gorm:"primaryKey"\``
- FK: `ExamID uint \`gorm:"not null;index"\`` + sibling `Exam Exam \`json:"-"\`` (never serialised)
- Secrets: `json:"-"` (e.g., `HashedPassword`, `SMTPAppPassword`)
- Nullable-until-set: pointer, e.g., `Score *float64` (`models/submission.go`)
- JSONB: `datatypes.JSON` from `gorm.io/datatypes` (`models/question.go`)
- Enums: typed `string` constant block (`models/question.go:6-12`, `models/feedback.go:5-13`)

AutoMigrate order in `database/database.go:20-28` must respect FK dependencies: Teacher → Exam → QuestionSet → Question → Submission → SubmissionAnswer → Feedback.

---

## 5. Public vs. Private Response Shapes

Teacher endpoints return models directly (secrets guarded by `json:"-"`). Student-facing endpoints use a dedicated response struct that whitelists safe fields — the model is never returned directly to students.

- Pattern: `publicExamResponse` / `publicQuestion` in `handlers/exam.go`
- Applied in: `GetPublicExam` — hides questions during buffer period, returns 410 after grace
- `CorrectAnswer` must **never** appear in any public response

---

## 6. Docker Sandbox Security Invariants

All ephemeral code execution containers (`runner/runner.go`) must always have:

- `NetworkMode: "none"` — no network access
- `Resources.Memory: 64MB`, `Resources.PidsLimit: 50`
- `ReadonlyRootfs: true` + `Tmpfs: {"/tmp": "rw,exec,size=10m"}` — `exec` flag is required so compiled C/C++ binaries in `/tmp` can run
- `SecurityOpt: ["no-new-privileges"]`
- Code delivered via **stdin goroutine** — never env vars (visible in `docker inspect`)
- Cleanup: `defer ContainerRemove(context.Background(), id, Force:true)` — fresh context, not the timeout context
- Output read with `stdcopy.StdCopy`, not `io.Copy` (Docker multiplexed stream)
- 15-second outer timeout: 8s compile + 5s run for C/C++; 5s for Python

---

## 7. Frontend API Client Pattern

All backend calls go through `frontend/src/api/client.ts`:

- One exported function per endpoint, typed with the response interface — add new endpoints here, not inline in page components
- All helpers use `.then(r => r.data)` to unwrap Axios
- Access token in module-scope variable (fast reads) + `localStorage` (survives refresh) — `client.ts:4-20`
- Global 401 interceptor forces logout; skipped for student paths — `client.ts:80-92`
- Teacher info cached in localStorage for Navbar avatar without extra API call

---

## 8. Route Authorization Split

`routes/routes.go` has three groups:

1. **`api`** (public) — login, student join/submit/execute, public exam view
2. **`protected`** (`JWTMiddleware`) — all teacher CRUD, grading, analytics, profile, mail, reports, feedback
3. **`admin`** (`JWTMiddleware` + `RequireRole("superadmin")`) — teacher management, feedback management

New teacher route → `protected`. New student route → `api` + DTO that strips `CorrectAnswer`. New admin route → `admin`.

---

## 9. Cascading Delete via Transactions

Operations touching multiple tables use `h.db.Transaction(func(tx *gorm.DB) error { ... })`. Always operate on `tx`, not `h.db`, inside the closure:

- Exam delete: submission_answers → submissions → questions → question_sets → exam — `handlers/exam.go`
- Question delete: submission_answers first — `handlers/question.go`
- Bulk submission: Submission + all SubmissionAnswers atomically — `handlers/submission.go`
- QuestionSet duplicate: clone set + child questions — `handlers/question_set.go`

---

## 10. Fail-Fast Batch Validation

When importing many rows, validate **all** before inserting any. Return per-row errors so users can fix everything in one pass:

- CSV question upload: collect all errors, bulk-insert only if zero — `handlers/upload.go`
- Offline import: SHA-256 tamper check before any DB write — `handlers/submission.go`

---

## 11. Deterministic Student Session IDs

Session IDs and question-set assignments are derived from `(JWT_SECRET, examId, email)` — same student always lands on the same set and can resume without storing state:

- Algorithm: `HMAC-SHA256(JWT_SECRET, "examId|email")` — `handlers/join.go`
- Session ID: `"STU-" + hex(digest[:4])`
- Set assignment: `uint32(digest[4:8]) % len(sets)`

Never use random values here — determinism is required for idempotent rejoins.

---

## 12. Credentials at Rest (AES-256-GCM)

Sensitive values stored in the DB (currently SMTP app passwords) are encrypted with AES-256-GCM before writing and decrypted on read. The encryption key is derived from `JWT_SECRET` via SHA-256 so no additional secret needs managing.

- Package: `crypto/aes.go` — `DeriveKey`, `Encrypt`, `Decrypt`
- Usage: `handlers/mail.go` (save and read)
- Pattern: `key := appcrypto.DeriveKey(h.cfg.JWTSecret)` then `appcrypto.Encrypt(value, key)`
- Never store plaintext credentials in the DB; never return the encrypted blob to clients

---

## 13. PDF Generation Split (Browser-Rich / Backend-Fallback)

Report PDFs have two generation paths:

**Browser (rich):** `frontend/src/utils/generateStudentPDF.ts` — jsPDF + jsPDF-autotable. Full report with score cards, progress bars, per-question breakdown. Used for downloads and single-send email.

**Backend (fallback):** `handlers/mail.go:buildReportPDF` — go-pdf/fpdf. Simpler layout. Used for bulk send-all (no browser context) or when browser PDF unavailable.

For `POST /reports/send/:id`: frontend POSTs `{ pdf_data: "<base64>" }`. If absent, server falls back to `buildReportPDF`.

---

## 14. Local Toast Notifications

Pages that need feedback toasts manage the state locally — there is no global toast provider:

```
const [toast, setToast] = useState<{message: string; type: 'success'|'error'}|null>(null)
const showToast = (message, type) => { setToast({message, type}); setTimeout(() => setToast(null), 3500) }
```

Replicated in `ExamView.tsx`, `AdminStaff.tsx`, and similar pages.

---

## 15. Force-Password-Change Gate

Teachers created by admins have `must_change_password: true`. `ProtectedRoute` checks this flag and redirects to `/force-password-change` before rendering any teacher page (`components/ProtectedRoute.tsx`). Cleared by `POST /auth/update-password`. `AdminRoute` applies the same check.

---

## 16. WebRTC Video Proctoring

Star topology: students connect only to the teacher, never to each other — prevents N-fold audio echo and keeps signaling simple.

- Hook: `hooks/useWebRTC.ts` — manages peer connections, WebSocket signaling, track management
- Signaling: WebSocket at `/api/ws` → Nginx upgrades + proxies to backend (`frontend/nginx.conf`)
- Backend: `handlers/room.go` (room/participant management), `handlers/webrtc.go` (upgrade middleware)
- Both teacher and student send all tracks (audio + video) through a single stream per peer — avoids echo from mismatched audio transceivers
- Browser echo cancellation (`echoCancellation: true` in getUserMedia) handles feedback prevention
- Audio starts muted; teacher video starts disabled — toggled via UI controls
- Teacher side: `pages/ExamMonitor.tsx` — VideoTile per student with separate `<video muted>` + hidden `<audio>` element (allows browser AEC to work)
- Student side: `pages/StudentExam.tsx` — DraggableCamera for local preview, hidden `<audio>` elements for teacher audio

---

## 17. Exam Proctoring & Violation Tracking

Fullscreen lockdown and violation detection during exams (`pages/StudentExam.tsx`):

- **Violation sources**: `visibilitychange` (tab switch), `blur` (new window), `fullscreenchange` (exit fullscreen), `paste` (clipboard)
- **Deduplication**: blur + visibilitychange use a 500ms timestamp guard to prevent double-counting on tab switch
- **Fullscreen grace**: 5-second countdown on exit, then first violation + repeating violations every 2 seconds until return or auto-submit
- **Auto-recovery**: click anywhere re-enters fullscreen during buffer and exam phases
- **Buffer phase**: fullscreen enforced from join, not just exam start
- **Violation limit**: configurable per exam; reaching limit triggers auto-submission
- **Download immunity**: `isDownloadingRef` suppresses violation counting during offline backup save; cleared on focus return, not a fixed timeout — prevents save-dialog-triggered violations

---

## 18. Exam Timeline & Lazy Expiry

Exam lifecycle is timeline-based with lazy deactivation:

- **Timeline**: T0 = `started_at`, BufferEnd = T0 + `buffer_duration_mins`, ExamEnd = BufferEnd + `duration_minutes`, GraceEnd = ExamEnd + 2min
- **Lazy expiry**: checked on every exam access — marks `is_active = false` after ExamEnd (`handlers/exam.go`)
- **Public endpoint**: hides questions during buffer, returns 410 after grace
- **Submissions**: rejected after grace period to guard race conditions

---

## 19. Theme System

Dark mode via CSS custom properties, not inline color logic:

- `ThemeContext` sets `data-theme` on `document.documentElement` (`contexts/ThemeContext.tsx`)
- CSS variables defined in `index.css` under `html` and `html[data-theme='dark']`
- Components use `var(--card-bg)`, `var(--text)`, `var(--border)` etc.
- `useTheme()` provides `isDark` boolean for cases where inline conditional is needed (e.g., primary button colors)
- Inline dark-mode colors use ternary: `isDark ? '#dark' : '#light'` — never hardcode light-only highlight colors (e.g., MCQ selected state, correct-answer badges)
- Persisted in localStorage key `exam_theme`

---

## 20. Login Rate Limiting

In-memory per-IP brute-force protection (`handlers/handler.go:31-92`):

- 5 failed attempts → 15-minute lockout per IP
- `loginLimiter` struct with `sync.Mutex` for thread safety
- `check(ip)` returns remaining lockout duration; `recordFailure(ip)` increments; `recordSuccess(ip)` clears
- Returns `429 Too Many Requests` with `Retry-After` header (`handlers/auth.go`)
- Counter resets after lockout expires, not just on success

---

## 21. Platform Settings (Single-Row AppSettings)

Feature flags stored in a single-row `app_settings` table (`models/settings.go`):

- Row seeded on startup with defaults (`database/database.go:49-53`)
- `isLLMEnabled()` helper checked at the top of `AutoGradeSubmission` and `AutoGradeAllSubmissions` (`handlers/llm_grader.go`)
- `GET /settings` (any teacher) reads flags; `PATCH /admin/settings` (superadmin) toggles them
- Frontend reads settings to conditionally show/hide auto-grade buttons (`ExamView.tsx`, `GradingView.tsx`)
- Admin toggles via `AdminStaff.tsx` settings card

---

## 22. Offline Submission Remapping

When an exam is deleted and reimported from `.examfull`, offline `.exam` files from the original exam have stale IDs. The import handler remaps them positionally (`handlers/submission.go:remapOfflineQuestionIDs`):

- Detects exam ID mismatch between file and target URL
- Matches question set by title (falls back to single-set exam)
- Sorts both old question IDs (from file) and new question IDs (from DB) ascending
- Maps positionally: old[0] → new[0], old[1] → new[1], etc.
- Fails fast if question count doesn't match

---

## 23. LLM Grading Architecture

Two-tier grading: synchronous for single submissions, async Celery queue for bulk:

- **Single**: `POST /submissions/:id/auto-grade` → sequential LLM calls with 1 retry (`handlers/llm_grader.go:callLLMGradeWithRetry`)
- **Bulk**: `POST /exams/:id/auto-grade-all` → submits batch to `/grade/batch`, polls `/grade/status` every 2s until done or 30-min timeout
- Code questions: sandbox-executed first (`runner.Run`), execution output passed to LLM for informed grading
- LLM service: FastAPI + llama-cpp-python running Qwen2.5-3B-Instruct GGUF (`llm-service/main.py`)
- Celery worker: separate model instance, concurrency=1 to prevent OOM (`llm-service/tasks.py`)
- Score clamped to `[0, maxPoints]` both in LLM service (parse) and Go handler (double-check)
- `recalcSubmission` updates `total_score` and `status` after grading (`handlers/llm_grader.go:464-488`)
