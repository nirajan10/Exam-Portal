# Architectural Patterns

Patterns that appear in multiple files across the codebase.

---

## 1. Dependency Injection via Handler Struct

All HTTP handlers are methods on a single `*Handler` struct that holds shared dependencies.

- Struct definition: `handlers/handler.go:9-14`
- Instantiation (single site): `main.go:58`
- Every handler follows: `func (h *Handler) Name(c *fiber.Ctx) error`

Never pass `db`, `runner`, or `cfg` as function parameters — add them to the `Handler` struct.

---

## 2. Ownership Authorization via SQL Joins

Every mutating handler verifies the authenticated teacher owns the target resource before acting. The pattern scales from top-level to deeply nested resources:

| Resource | Join depth | File:Line |
|----------|-----------|-----------|
| Exam | `WHERE teacher_id = ?` | `handlers/exam.go:82-86` |
| QuestionSet | JOIN exams | `handlers/question_set.go:52-56` |
| Question | JOIN question_sets JOIN exams | `handlers/question.go:55-60` |

`ExtractTeacherID(c)` is called at the top of every protected handler to get the caller's ID from the JWT — `middleware/jwt.go:22`.

Ownership failures always return 404 (not 403) to avoid leaking resource existence.

---

## 3. Fiber Error Handling

All handlers return `fiber.NewError(statusCode, message)`. A single global handler in `main.go:38-44` converts these to `{"error": "..."}` JSON. Never write `c.Status().JSON()` for errors inline.

```
fiber.NewError(fiber.StatusBadRequest, "...")   → 400
fiber.NewError(fiber.StatusUnauthorized, "...")  → 401
fiber.NewError(fiber.StatusNotFound, "...")      → 404
fiber.NewError(fiber.StatusConflict, "...")      → 409
```

---

## 4. GORM Model Conventions

All models follow this pattern (reference: `models/teacher.go`):

- PK: `ID uint \`gorm:"primaryKey"\``
- FKs: `ExamID uint \`gorm:"not null;index"\`` + sibling `Exam Exam \`gorm:"foreignKey:ExamID" json:"-"\``
- Secret fields: `json:"-"` tag (e.g., `HashedPassword`, `CorrectAnswer` in teacher responses)
- Nullable until set: pointer type, e.g., `Score *float64` (`models/submission.go:13`)
- JSONB columns: `datatypes.JSON` from `gorm.io/datatypes` (`models/question.go:19`)
- Enum types: typed `string` constant + `const` block (`models/question.go:7-10`)

AutoMigrate order in `database/database.go:19-25` must respect FK dependencies (Teacher → Exam → QuestionSet → Question → Submission).

---

## 5. Public vs. Private Response Shapes

Teacher endpoints return models directly (with `json:"-"` protecting secrets). Student-facing endpoints use a dedicated response struct that explicitly lists safe fields — never return the model directly to students.

- Pattern: `publicExamResponse` / `publicQuestion` structs in `handlers/exam.go:12-29`
- Applied in: `handlers/exam.go:100-118` (`GetPublicExam`)
- Rule: `CorrectAnswer` must **never** appear in public responses

---

## 6. Docker Sandbox Security Invariants

All ephemeral code execution containers (`runner/runner.go:106-130`) must always have:

- `NetworkMode: "none"` — no network access
- `Resources.Memory: 64MB`, `Resources.PidsLimit: 50` — resource caps
- `ReadonlyRootfs: true` + `Tmpfs: {"/tmp": "rw,size=10m"}` — writable scratch only
- `SecurityOpt: ["no-new-privileges"]`
- Code passed via **stdin goroutine** — never via env vars (visible in `docker inspect`)
- `defer ContainerRemove(context.Background(), id, Force:true)` — fresh context, not the timeout context
- Output read with `stdcopy.StdCopy` — not `io.Copy` (Docker stream is multiplexed)

---

## 7. Frontend API Client Pattern

All backend calls go through `frontend/src/api/client.ts`. The pattern is:

- One exported helper function per endpoint, typed with the response interface
- All helpers use `.then(r => r.data)` to unwrap Axios response
- Access token held in module-scope variable (not `localStorage`) — `client.ts:4`
- `setAccessToken()` called from login/register handlers after success — `client.ts:6`
- `withCredentials: true` on the Axios instance for cookie support — `client.ts:11`

Add new endpoints here, not inline in page components.

---

## 8. Route Authorization Split

`routes/routes.go` has two groups:

1. **Public group** (`api`) — no middleware: auth endpoints, `GET /exams/:id/public`, `POST /submissions`
2. **Protected group** (`protected`) — wraps `middleware.JWTMiddleware(jwtSecret)`: all teacher CRUD + `/execute`

Adding a new teacher-only route: attach to `protected` group. Adding a student route: attach to `api` group and ensure the handler uses a DTO that strips `CorrectAnswer`.
