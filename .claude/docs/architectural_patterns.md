# Architectural Patterns

Patterns that appear across multiple files. Check the relevant section before adding new features.

---

## 1. Dependency Injection via Handler Struct

All HTTP handlers are methods on a single `*Handler` that holds shared dependencies.

- Struct + fields: `handlers/handler.go:9-14`
- Constructed once: `main.go:58`
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
| Report send | `WHERE exam.teacher_id = ?` | `handlers/mail.go:175-178` |

`middleware.ExtractTeacherID(c)` is called at the top of every protected handler (`middleware/jwt.go:22`). Ownership failures always return **404**, not 403, to avoid leaking resource existence.

---

## 3. Fiber Error Handling

All handlers return `fiber.NewError(statusCode, message)`. One global handler in `main.go:36-42` converts these to `{"error": "..."}` JSON. Never write inline `c.Status().JSON()` for error responses.

```
fiber.NewError(fiber.StatusBadRequest, "...")    → 400
fiber.NewError(fiber.StatusUnauthorized, "...")  → 401
fiber.NewError(fiber.StatusNotFound, "...")      → 404
fiber.NewError(fiber.StatusConflict, "...")      → 409
```

---

## 4. GORM Model Conventions

Reference: `models/teacher.go`, `models/submission.go`, `models/question.go`

- PK: `ID uint \`gorm:"primaryKey"\``
- FK: `ExamID uint \`gorm:"not null;index"\`` + sibling `Exam Exam \`json:"-"\`` (never serialised)
- Secrets: `json:"-"` (e.g., `HashedPassword`, `SMTPAppPassword`)
- Nullable-until-set: pointer, e.g., `Score *float64` (`models/submission.go:46`)
- JSONB: `datatypes.JSON` from `gorm.io/datatypes` (`models/question.go:21`)
- Enums: typed `string` constant block (`models/question.go:6-12`)

AutoMigrate order in `database/database.go:19-25` must respect FK dependencies: Teacher → Exam → QuestionSet → Question → Submission → SubmissionAnswer.

---

## 5. Public vs. Private Response Shapes

Teacher endpoints return models directly (secrets guarded by `json:"-"`). Student-facing endpoints use a dedicated response struct that whitelists safe fields — the model is never returned directly to students.

- Pattern: `publicExamResponse` / `publicQuestion` in `handlers/exam.go:12-29`
- Applied in: `handlers/exam.go:100-118` (`GetPublicExam`)
- `CorrectAnswer` must **never** appear in any public response

---

## 6. Docker Sandbox Security Invariants

All ephemeral code execution containers (`runner/runner.go:106-130`) must always have:

- `NetworkMode: "none"` — no network access
- `Resources.Memory: 64MB`, `Resources.PidsLimit: 50`
- `ReadonlyRootfs: true` + `Tmpfs: {"/tmp": "rw,size=10m"}`
- `SecurityOpt: ["no-new-privileges"]`
- Code delivered via **stdin goroutine** — never env vars (visible in `docker inspect`)
- Cleanup: `defer ContainerRemove(context.Background(), id, Force:true)` — fresh context, not the timeout context
- Output read with `stdcopy.StdCopy`, not `io.Copy` (Docker multiplexed stream)

---

## 7. Frontend API Client Pattern

All backend calls go through `frontend/src/api/client.ts`:

- One exported function per endpoint, typed with the response interface — add new endpoints here, not inline in page components
- All helpers use `.then(r => r.data)` to unwrap Axios
- Access token in module-scope variable (fast reads) + `localStorage` (survives refresh) — `client.ts:4-8`
- Global 401 interceptor forces logout; skipped for student paths — `client.ts:20-30`

---

## 8. Route Authorization Split

`routes/routes.go` has three groups, in order:

1. **`api`** (public) — login, student join/submit/execute, public exam view
2. **`protected`** (`JWTMiddleware`) — all teacher CRUD, grading, analytics, profile, mail settings, reports
3. **`admin`** (`JWTMiddleware` + `RequireRole("superadmin")`) — teacher account management (`routes/routes.go:86-95`)

New teacher route → `protected`. New student route → `api` + DTO strips `CorrectAnswer`. New admin route → `admin`.

---

## 9. Cascading Delete/Create via Transactions

Operations touching multiple tables use `h.db.Transaction(func(tx *gorm.DB) error { ... })`. Always operate on `tx`, not `h.db`, inside the closure:

- Exam delete: submission_answers → submissions → questions → question_sets → exam — `handlers/exam.go:210-240`
- Question delete: submission_answers first — `handlers/question.go:115-130`
- Bulk submission: Submission + all SubmissionAnswers atomically — `handlers/submission.go:90-140`
- QuestionSet duplicate: clone set + child questions — `handlers/question_set.go:95-130`

---

## 10. Fail-Fast Batch Validation

When importing many rows, validate **all** before inserting any. Return per-row errors so users can fix everything in one pass:

- CSV question upload: collect all errors, bulk-insert only if zero — `handlers/upload.go:50-120`
- Offline import: SHA-256 tamper check before any DB write — `handlers/submission.go:430-460`

---

## 11. Deterministic Student Session IDs

Session IDs and question-set assignments are derived from `(JWT_SECRET, examId, email)` — same student always lands on the same set and can resume without storing state:

- Algorithm: `HMAC-SHA256(JWT_SECRET, "examId|email")` — `handlers/join.go:45-60`
- Session ID: `"STU-" + hex(digest[:4])`
- Set assignment: `uint32(digest[4:8]) % len(sets)`

Never use random values here — determinism is required for idempotent rejoins.

---

## 12. Credentials at Rest (AES-256-GCM)

Sensitive values stored in the DB (currently SMTP app passwords) are encrypted with AES-256-GCM before writing and decrypted on read. The encryption key is derived from `JWT_SECRET` via SHA-256 so no additional secret needs managing.

- Package: `crypto/aes.go` — `DeriveKey`, `Encrypt`, `Decrypt`
- Usage: `handlers/mail.go:88-93` (save) and `handlers/mail.go:129-131` (read)
- Pattern: `key := appcrypto.DeriveKey(h.cfg.JWTSecret)` then `appcrypto.Encrypt(value, key)`
- Never store plaintext credentials in the DB; never return the encrypted blob to clients

---

## 13. PDF Generation Split (Browser-Rich / Backend-Fallback)

Report PDFs have two generation paths depending on context:

**Browser (rich):** `frontend/src/utils/generateStudentPDF.ts` uses jsPDF + jsPDF-autotable. Produces a full report with score cards, progress bars, MCQ table, code blocks, and theory answers. Used for downloads (`ResultsAnalytics.tsx:680-682`) and single-send email (`ExamView.tsx:1070-1080`).

**Backend (fallback):** `handlers/mail.go:buildReportPDF` uses `go-pdf/fpdf`. Simpler layout. Used when browser PDF is unavailable (bulk send-all via goroutine, or browser generation failure).

For `POST /reports/send/:id`: the frontend generates the PDF, base64-encodes it, and POSTs `{ pdf_data: "<base64>" }`. The handler decodes and attaches it. If `pdf_data` is absent or invalid the server falls back to `buildReportPDF` — `handlers/mail.go:193-205`.

For `POST /reports/send-all`: runs asynchronously in a goroutine with no browser context — always uses `buildReportPDF`.

---

## 14. Local Toast Notifications

Pages that need feedback toasts manage the state locally — there is no global toast provider. The pattern used in `ExamView.tsx` and replicated where needed:

```
const [toast, setToast] = useState<{message: string; type: 'success'|'error'}|null>(null)
const showToast = (message, type) => { setToast({message, type}); setTimeout(() => setToast(null), 3500) }
```

- Toast component defined inline at the bottom of `ExamView.tsx:897-920`
- Rendered conditionally: `{toast && <Toast ... />}`

---

## 15. Force-Password-Change Gate

Teachers created by admins have `must_change_password: true`. `ProtectedRoute` checks this flag and redirects to `/force-password-change` before rendering any teacher page (`components/ProtectedRoute.tsx:19-24`). The flag is cleared by `POST /auth/update-password` on success (`handlers/auth.go:79`). `AdminRoute` applies the same check (`components/ProtectedRoute.tsx:46`).
