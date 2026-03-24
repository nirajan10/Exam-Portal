import axios from 'axios'

// ── Token storage ──────────────────────────────────────────────────────────────
// Kept in both an in-memory variable (fast, no serialisation) and localStorage
// (survives page refresh). Neither location is perfectly XSS-safe, but this
// is the standard SPA trade-off; httpOnly cookies would require backend changes.

const TOKEN_KEY = 'exam_teacher_token'

// Restore from localStorage on module load so a page refresh keeps the session.
let accessToken: string | null = localStorage.getItem(TOKEN_KEY)

export const setAccessToken = (token: string | null) => {
  accessToken = token
  if (token) {
    localStorage.setItem(TOKEN_KEY, token)
  } else {
    localStorage.removeItem(TOKEN_KEY)
  }
}

/** Returns the current token (null if logged out or never logged in). */
export const getAccessToken = () => accessToken

// ── Teacher info storage ───────────────────────────────────────────────────────
// Cached alongside the token so the Navbar can display name/avatar without an
// extra API call on every page load.

const TEACHER_KEY = 'exam_teacher_info'

let cachedTeacher: Teacher | null = (() => {
  try { return JSON.parse(localStorage.getItem(TEACHER_KEY) ?? 'null') as Teacher }
  catch { return null }
})()

export const setTeacher = (t: Teacher | null) => {
  cachedTeacher = t
  if (t) localStorage.setItem(TEACHER_KEY, JSON.stringify(t))
  else localStorage.removeItem(TEACHER_KEY)
}

/** Returns the locally cached teacher info (does not make a network request). */
export const getTeacher = () => cachedTeacher

/** Clear credentials and hard-navigate to /login. */
export const logout = () => {
  setAccessToken(null)
  setTeacher(null)
  // Hard redirect so all in-memory React state is wiped.
  window.location.replace('/login')
}

// ── Axios instance ─────────────────────────────────────────────────────────────

const api = axios.create({ baseURL: '/api' })

// Attach token to every request automatically.
api.interceptors.request.use(config => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`
  return config
})

// Public student endpoints — never redirect to the teacher login page on error.
// These routes intentionally use no auth or a short-lived PIN token.
//
// IMPORTANT: Axios stores the request URL in err.config.url WITHOUT the baseURL
// prefix (e.g. '/exams/5/verify-pin', not '/api/exams/5/verify-pin').
// We reconstruct the full URL by prepending err.config.baseURL so pattern
// matching works correctly regardless of how the instance is configured.
const STUDENT_PATH_PATTERNS = ['/exams/', '/submissions']
const isStudentRequest = (config?: { url?: string; baseURL?: string }) => {
  if (!config?.url) return false
  const full = (config.baseURL ?? '') + config.url
  return STUDENT_PATH_PATTERNS.some(p => full.includes(p))
}

// Global 401 handler: expired or invalid teacher token → force logout.
// Skipped entirely for student-facing routes so a wrong exam PIN never
// clears the teacher session or redirects to /login.
api.interceptors.response.use(
  res => res,
  err => {
    if (
      err.response?.status === 401 &&
      !window.location.pathname.startsWith('/login') &&
      !isStudentRequest(err.config)
    ) {
      logout()
    }
    return Promise.reject(err)
  },
)

export default api

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface Teacher {
  id: number
  name: string
  email: string
  profile_pic: string // empty string when no custom picture uploaded
  role: 'teacher' | 'superadmin'
  is_active: boolean
  must_change_password: boolean
  created_at: string
  smtp_sender_name: string
  smtp_email: string
}

export interface LoginResponse {
  access_token: string
  teacher: Teacher
}

export const login = async (email: string, password: string): Promise<LoginResponse> => {
  const { data } = await api.post<LoginResponse>('/auth/login', { email, password })
  setAccessToken(data.access_token)
  setTeacher(data.teacher) // cache teacher info for Navbar display
  return data
}

export const register = async (name: string, email: string, password: string): Promise<Teacher> => {
  const { data } = await api.post<Teacher>('/auth/register', { name, email, password })
  return data
}

// ── Teacher profile ───────────────────────────────────────────────────────────

/** Fetches fresh teacher profile from the server and updates the local cache. */
export const getMe = (): Promise<Teacher> =>
  api.get<Teacher>('/me').then(r => { setTeacher(r.data); return r.data })

/** Uploads a new profile picture and returns the updated teacher record. */
export const uploadProfilePic = (file: File): Promise<Teacher> => {
  const fd = new FormData()
  fd.append('picture', file)
  return api.post<Teacher>('/me/profile-pic', fd).then(r => { setTeacher(r.data); return r.data })
}

// ── Exams ─────────────────────────────────────────────────────────────────────

export interface Exam {
  id: number
  teacher_id: number
  title: string
  description: string
  created_at: string
  duration_minutes: number
  // randomize_question_order shuffles the sequence of questions each student sees.
  randomize_question_order: boolean
  camera_proctoring_required: boolean
  violation_limit: number
  max_code_runs: number // 0 = disabled, 1–3 = allowed runs per question
  is_active: boolean
  started_at: string | null      // ISO timestamp when teacher started the exam; null if never started
  buffer_duration_minutes: number // lead-in buffer before questions are revealed
  login_code: string   // PIN students enter in the lobby — teacher-visible only
  question_sets?: QuestionSet[]
}

/** Returned by GET /api/exams/active — login_code intentionally absent. */
export interface ActiveExam {
  id: number
  title: string
  description: string
  duration_minutes: number
  teacher_name: string
  started_at: string | null
  buffer_duration_minutes: number
}

export interface VerifyPinResponse {
  access_token: string
  exam_id: number
}

export interface QuestionSet {
  id: number
  exam_id: number
  title: string
  order: number
  questions?: Question[]
}

export interface Question {
  id: number
  question_set_id: number
  type: 'MCQ' | 'MRQ' | 'code' | 'theory'
  content: string
  options: string[] | null
  // correct_answers: teacher view only — array of correct option strings.
  // MCQ has one entry; MRQ has two or more.
  correct_answers?: string[]
  // randomize_options: if true, student UI shuffles the option order.
  randomize_options: boolean
  points: number
  // language: compiler/runtime for code questions ("python", "c", "cpp"). Empty for other types.
  language?: string
}

/** One student's answer to a single question within a Submission. */
export interface SubmissionAnswer {
  id: number
  submission_id: number
  question_id: number
  answer: string
  /** null = not yet graded; 0 or positive = score awarded */
  score: number | null
  feedback: string
}

/** One student's complete exam attempt. */
export interface Submission {
  id: number
  exam_id: number
  /** Backend-generated session identifier, e.g. "STU-A1B2C3D4". */
  session_id: string
  /** ID of the QuestionSet the student received (0 if unknown/legacy). */
  question_set_id: number
  /** Human-readable name of the assigned set, e.g. "Set A". Empty for legacy submissions. */
  set_name: string
  student_name: string
  student_email: string
  submitted_at: string
  total_score: number
  status: 'graded' | 'pending_grading'
  /** ISO timestamp of when the student's report email was sent; null if not yet sent. */
  notified_at: string | null
  /** Populated only by getSubmission() (grading view) */
  answers?: SubmissionAnswer[]
}

export const getActiveExams = () => api.get<ActiveExam[]>('/exams/active').then(r => r.data)
export const verifyPin = (id: number, loginCode: string) =>
  api.post<VerifyPinResponse>(`/exams/${id}/verify-pin`, { login_code: loginCode }).then(r => r.data)

/** Join an exam: returns a deterministic session ID and the assigned question set ID. */
export interface JoinResponse {
  session_id: string
  assigned_set_id: number
}
export const joinExam = (examId: number, studentName: string, studentEmail: string): Promise<JoinResponse> =>
  api.post<JoinResponse>(`/exams/${examId}/join`, { student_name: studentName, student_email: studentEmail }).then(r => r.data)

export const getExams = () => api.get<Exam[]>('/exams').then(r => r.data)
export const getExam = (id: number) => api.get<Exam>(`/exams/${id}`).then(r => r.data)
export const getPublicExam = (id: number) => api.get<Exam>(`/exams/${id}/public`).then(r => r.data)
export const createExam = (payload: Partial<Exam>) => api.post<Exam>('/exams', payload).then(r => r.data)
export const updateExam = (id: number, payload: Partial<Exam>) => api.put<Exam>(`/exams/${id}`, payload).then(r => r.data)
export const toggleExamStatus = (id: number, isActive: boolean) =>
  api.patch<Exam>(`/exams/${id}/status`, { is_active: isActive }).then(r => r.data)
export const deleteExam = (id: number) => api.delete(`/exams/${id}`)

export const createQuestionSet = (payload: Partial<QuestionSet>) =>
  api.post<QuestionSet>('/question-sets', payload).then(r => r.data)
export const updateQuestionSet = (id: number, payload: Partial<QuestionSet>) =>
  api.put<QuestionSet>(`/question-sets/${id}`, payload).then(r => r.data)
export const deleteQuestionSet = (id: number) => api.delete(`/question-sets/${id}`)
export const duplicateQuestionSet = (id: number, title?: string) =>
  api.post<QuestionSet>(`/question-sets/${id}/duplicate`, title ? { title } : {}).then(r => r.data)

export const createQuestion = (payload: Partial<Question> & { options?: string[] | null; correct_answers?: string[] }) =>
  api.post<Question>('/questions', payload).then(r => r.data)
export const updateQuestion = (id: number, payload: Partial<Question>) =>
  api.put<Question>(`/questions/${id}`, payload).then(r => r.data)
export const deleteQuestion = (id: number) => api.delete(`/questions/${id}`)

export const submitAnswer = (payload: {
  exam_id: number
  student_name: string
  student_email: string
  question_id: number
  answer: string
}) => api.post<Submission>('/submissions', payload).then(r => r.data)

/** Batch submit — sends all answers in one atomic request. */
export interface SubmitExamPayload {
  student_name: string
  student_email: string
  /** Session ID returned by joinExam — links this submission to the student's session. */
  session_id: string
  answers: Array<{ question_id: number; answer: string }>
}
export const submitExam = (examId: number, payload: SubmitExamPayload): Promise<Submission> =>
  api.post<Submission>(`/exams/${examId}/submit`, payload).then(r => r.data)

/** List all submissions for an exam (no answers preloaded). */
export const getSubmissions = (examId: number) =>
  api.get<Submission[]>(`/submissions?exam_id=${examId}`).then(r => r.data)

/** Permanently delete a submission and all its answers. */
export const deleteSubmission = (id: number) => api.delete(`/submissions/${id}`)

/** Get a single submission with all answers preloaded (for the grading view). */
export const getSubmission = (id: number) =>
  api.get<Submission>(`/submissions/${id}`).then(r => r.data)

/** Award marks and feedback for manual-grading answers. */
export const gradeSubmission = (
  id: number,
  grades: Array<{ answer_id: number; score: number; feedback: string }>,
): Promise<Submission> =>
  api.patch<Submission>(`/submissions/${id}/grade`, { grades }).then(r => r.data)

// ── LLM auto-grading ──────────────────────────────────────────────────────

export interface AutoGradeResult {
  submission: Submission
  graded: number
}

export interface AutoGradeAllResult {
  submissions_processed: number
  answers_graded: number
  message: string
}

export const getLLMHealth = (): Promise<{ status: string }> =>
  api.get<{ status: string }>('/llm/health').then(r => r.data)

export const autoGradeSubmission = (submissionId: number): Promise<AutoGradeResult> =>
  api.post<AutoGradeResult>(`/submissions/${submissionId}/auto-grade`, {}, { timeout: 120_000 }).then(r => r.data)

export const autoGradeAllSubmissions = (examId: number): Promise<AutoGradeAllResult> =>
  api.post<AutoGradeAllResult>(`/exams/${examId}/auto-grade-all`, {}, { timeout: 600_000 }).then(r => r.data)

// ── Code execution ────────────────────────────────────────────────────────────

export interface RunResult {
  stdout: string
  stderr: string
  exit_code: number
  timed_out: boolean
}

// Teacher sandbox — JWT-protected, no exam context, no run-count limit.
// Optional `stdin` is piped to the running program (uses base64-embed mode).
export const executeCode = (language: 'c' | 'cpp' | 'python', code: string, stdin?: string): Promise<RunResult> =>
  api.post<RunResult>('/execute', { language, code, ...(stdin !== undefined ? { stdin } : {}) }).then(r => r.data)

// ── Offline submission import ─────────────────────────────────────────────────

/** Import a student's offline backup file for a specific exam (exam id must match file). */
export const importOfflineSubmission = (examId: number, base64Data: string): Promise<Submission> =>
  api.post<Submission>(`/exams/${examId}/import-offline`, { data: base64Data }).then(r => r.data)

/**
 * Import a student's offline backup file without specifying an exam id —
 * the exam id is read from inside the file. The teacher must own that exam.
 * Corresponds to POST /api/submissions/import.
 */
export const importOfflineAuto = (base64Data: string): Promise<Submission> =>
  api.post<Submission>('/submissions/import', { data: base64Data }).then(r => r.data)

// ── Whole-exam export / import ─────────────────────────────────────────────────

/** Export the entire exam (metadata, questions, submissions) as a portable JSON file. */
export const exportWholeExam = (examId: number): Promise<Blob> =>
  api.get(`/exams/${examId}/export`, { responseType: 'blob' }).then(r => r.data)

/** Import a previously-exported .examfull file, creating a new exam. */
export const importWholeExam = (data: unknown): Promise<{ exam_id: number; message: string }> =>
  api.post('/exams/import', data).then(r => r.data)

// ── CSV bulk upload ───────────────────────────────────────────────────────────

export interface UploadResult {
  inserted: number
  errors?: Array<{ row: number; message: string }>
}

export const uploadQuestions = (examId: number, setId: number | null, file: File): Promise<UploadResult> => {
  const fd = new FormData()
  fd.append('file', file)
  const url = setId
    ? `/exams/${examId}/upload-questions?set_id=${setId}`
    : `/exams/${examId}/upload-questions`
  return api.post<UploadResult>(url, fd).then(r => r.data)
}

// ── Admin — teacher management ────────────────────────────────────────────────

export const getAdminTeachers = (): Promise<Teacher[]> =>
  api.get<Teacher[]>('/admin/teachers').then(r => r.data)

export interface CreateTeacherResponse {
  teacher: Teacher
  temp_password: string
}

export const createTeacher = (payload: { name: string; email: string }): Promise<CreateTeacherResponse> =>
  api.post<CreateTeacherResponse>('/admin/create-teacher', payload).then(r => r.data)

export const resetTeacherPassword = (id: number): Promise<{ temp_password: string }> =>
  api.patch<{ temp_password: string }>(`/admin/teachers/${id}/reset-password`).then(r => r.data)

export const updatePassword = (newPassword: string): Promise<void> =>
  api.post('/auth/update-password', { new_password: newPassword }).then(() => undefined)

export const setTeacherActive = (id: number, active: boolean): Promise<void> =>
  api.patch(`/admin/teachers/${id}/active`, { active }).then(() => undefined)

export const deleteTeacher = (id: number): Promise<void> =>
  api.delete(`/admin/teachers/${id}`).then(() => undefined)

export const getAdminTeacherExams = (id: number): Promise<Exam[]> =>
  api.get<Exam[]>(`/admin/teachers/${id}/exams`).then(r => r.data)

// ── Analytics ─────────────────────────────────────────────────────────────────

export interface QuestionStat {
  question_id: number
  question_content: string
  question_type: string
  correct_count: number
  total_attempts: number
  max_points: number
}

export interface ExamAnalytics {
  submission_count: number
  avg_score: number
  max_possible_score: number
  pass_rate: number
  avg_completion_mins: number | null
  /** Counts for [0–40%, 41–70%, 71–100%] */
  score_buckets: [number, number, number]
  question_stats: QuestionStat[]
}

export const getExamAnalytics = (examId: string | number): Promise<ExamAnalytics> =>
  api.get<ExamAnalytics>(`/exams/${examId}/analytics`).then(r => r.data)

// ── Mail settings ─────────────────────────────────────────────────────────────

export interface MailSettings {
  smtp_sender_name: string
  smtp_email: string
  /** true when an encrypted app password exists in the DB (never the raw value) */
  password_is_set: boolean
}

export interface SaveMailSettingsPayload {
  smtp_sender_name: string
  smtp_email: string
  /** Plain-text app password. If empty, the stored password is unchanged. */
  app_password: string
}

export const getMailSettings = (): Promise<MailSettings> =>
  api.get<MailSettings>('/me/mail-settings').then(r => r.data)

export const saveMailSettings = (payload: SaveMailSettingsPayload): Promise<MailSettings> =>
  api.put<MailSettings>('/me/mail-settings', payload).then(r => r.data)

/** Sends a test email to the teacher's own address. Throws on SMTP failure. */
export const testMailConnection = (): Promise<{ sent_to: string }> =>
  api.post<{ sent_to: string }>('/me/mail-settings/test').then(r => r.data)

// ── Performance reports ───────────────────────────────────────────────────────

/** Send a graded report to a single student. Returns the updated Submission.
 *  pdfBase64: base64-encoded PDF to attach (generated in browser); if omitted the backend generates one. */
export const sendReport = (submissionId: number, pdfBase64?: string): Promise<Submission> =>
  api.post<Submission>(`/reports/send/${submissionId}`, pdfBase64 ? { pdf_data: pdfBase64 } : undefined).then(r => r.data)

/** Queue reports for all graded, unnotified submissions of an exam (background). */
export const sendAllReports = (examId: number): Promise<{ queued: number; message: string }> =>
  api.post<{ queued: number; message: string }>(`/reports/send-all?exam_id=${examId}`).then(r => r.data)

// Student execution — public, checks exam's max_code_runs on the backend.
// `stdin` is optional program input; when non-empty the backend uses base64-embed
// mode so the container's stdin is free for the running program to read.
export const executeCodeForStudent = (
  examId: number,
  language: 'c' | 'cpp' | 'python',
  code: string,
  stdin?: string,
): Promise<RunResult> =>
  api.post<RunResult>(`/exams/${examId}/execute`, { language, code, ...(stdin !== undefined ? { stdin } : {}) }).then(r => r.data)

// ── Teacher feedback ──────────────────────────────────────────────────────────

export type FeedbackType = 'bug' | 'suggestion' | 'usability' | 'performance' | 'other'

export interface Feedback {
  id: number
  teacher_id: number
  type: FeedbackType
  subject: string
  body: string
  created_at: string
  teacher?: { id: number; name: string; email: string; profile_pic: string }
}

export const createFeedback = (payload: { type: FeedbackType; subject: string; body: string }): Promise<Feedback> =>
  api.post<Feedback>('/feedback', payload).then(r => r.data)

export const listAllFeedback = (): Promise<Feedback[]> =>
  api.get<Feedback[]>('/admin/feedback').then(r => r.data)

export const deleteFeedback = (id: number): Promise<void> =>
  api.delete(`/admin/feedback/${id}`).then(() => {})
