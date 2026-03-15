import { useEffect, useRef, useState, FormEvent, type CSSProperties } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { getExam, updateExam, Exam } from '../api/client'
import { useTheme } from '../contexts/ThemeContext'

// ── Toast notification ────────────────────────────────────────────────────────

interface ToastState {
  type: 'success' | 'error'
  message: string
}

function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4500)
    return () => clearTimeout(t)
  }, [toast])

  const isSuccess = toast.type === 'success'
  return (
    <div style={{
      position: 'fixed', top: 20, right: 20, zIndex: 1000,
      padding: '12px 16px', borderRadius: 8, fontSize: 14,
      background: isSuccess ? '#f0fdf4' : '#fef2f2',
      color: isSuccess ? '#15803d' : '#dc2626',
      border: `1px solid ${isSuccess ? '#86efac' : '#fca5a5'}`,
      boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
      display: 'flex', alignItems: 'flex-start', gap: 10,
      maxWidth: 380, minWidth: 260,
    }}>
      <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>
        {isSuccess ? '✓' : '⚠'}
      </span>
      <span style={{ flex: 1, lineHeight: 1.5 }}>{toast.message}</span>
      <button
        onClick={onDismiss}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 18, color: 'inherit', lineHeight: 1, padding: 0, flexShrink: 0,
        }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <>
      <style>{`
        @keyframes exam-edit-spin { to { transform: rotate(360deg); } }
        .exam-edit-spinner {
          display: inline-block;
          width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.4);
          border-top-color: white;
          border-radius: 50%;
          animation: exam-edit-spin 0.7s linear infinite;
          vertical-align: middle;
          margin-right: 7px;
        }
      `}</style>
      <span className="exam-edit-spinner" />
    </>
  )
}

// ── Shared style helpers ───────────────────────────────────────────────────────

const mkSection = (isDark: boolean): CSSProperties => ({
  background: isDark ? '#1e293b' : '#f9fafb',
  border: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
  borderRadius: 8,
  padding: 20,
  marginBottom: 20,
})

const mkLabel = (isDark: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'baseline',
  fontSize: 13,
  fontWeight: 600,
  color: isDark ? '#cbd5e1' : '#374151',
  marginBottom: 2,
})

function FieldHint({ text }: { text: string }) {
  return (
    <span style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic', marginLeft: 6, fontWeight: 400 }}>
      {text}
    </span>
  )
}

function FieldError({ message }: { message: string }) {
  if (!message) return null
  return (
    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#dc2626', display: 'flex', alignItems: 'center', gap: 4 }}>
      <span>⚠</span> {message}
    </p>
  )
}

function inputStyle(hasError = false): CSSProperties {
  return {
    width: '100%',
    padding: '8px 10px',
    marginTop: 4,
    border: `1px solid ${hasError ? '#dc2626' : '#d1d5db'}`,
    borderRadius: 6,
    fontSize: 14,
    boxSizing: 'border-box',
    outline: hasError ? '2px solid #fca5a5' : undefined,
    outlineOffset: hasError ? 1 : undefined,
  }
}

function Toggle({ label, hint, checked, onChange, isDark = false }: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
  isDark?: boolean
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{
          width: 40, height: 22, borderRadius: 11, flexShrink: 0, marginTop: 2,
          background: checked ? '#1a73e8' : (isDark ? '#475569' : '#d1d5db'),
          border: 'none', position: 'relative', cursor: 'pointer',
          transition: 'background 0.2s',
        }}
      >
        <span style={{
          position: 'absolute', top: 2, left: checked ? 20 : 2, width: 18, height: 18,
          borderRadius: '50%', background: 'white',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transition: 'left 0.2s',
          display: 'block',
        }} />
      </button>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14, color: isDark ? '#f1f5f9' : '#111827' }}>{label}</div>
        <div style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#6b7280', marginTop: 2, fontStyle: 'italic' }}>{hint}</div>
      </div>
    </div>
  )
}

// ── Validation ────────────────────────────────────────────────────────────────

interface FormErrors {
  title?: string
  duration?: string
  violationLimit?: string
  maxCodeRuns?: string
  loginCode?: string
}

function validateForm(
  title: string,
  durationMinutes: number | '',
  violationLimit: number | '',
  maxCodeRuns: number,
  loginCode: string,
): FormErrors {
  const e: FormErrors = {}
  if (!title.trim()) {
    e.title = 'Title is required.'
  }
  if (durationMinutes === '' || Number(durationMinutes) <= 0) {
    e.duration = 'Duration must be a positive number (e.g. 60 for one hour).'
  } else if (Number(durationMinutes) > 600) {
    e.duration = 'Duration cannot exceed 600 minutes (10 hours).'
  }
  if (violationLimit !== '' && Number(violationLimit) < 0) {
    e.violationLimit = 'Violation limit cannot be negative.'
  }
  if (maxCodeRuns < 0 || maxCodeRuns > 3) {
    e.maxCodeRuns = 'Max code runs must be between 0 and 3.'
  }
  if (loginCode.trim() && loginCode.trim().length < 4) {
    e.loginCode = 'PIN must be at least 4 characters.'
  }
  return e
}

function extractErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: string; message?: string } } })?.response?.data
  return data?.error ?? data?.message ?? fallback
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ExamEdit() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { isDark } = useTheme()

  const sectionStyle = mkSection(isDark)
  const labelStyle   = mkLabel(isDark)

  const text  = isDark ? '#f1f5f9' : '#111827'
  const muted = isDark ? '#94a3b8' : '#6b7280'

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [durationMinutes, setDurationMinutes] = useState<number | ''>(60)
  const [randomizeOrder, setRandomizeOrder] = useState(false)
  const [cameraProctoring, setCameraProctoring] = useState(false)
  const [violationLimit, setViolationLimit] = useState<number | ''>(0)
  const [maxCodeRuns, setMaxCodeRuns] = useState(0)
  const [loginCode, setLoginCode] = useState('')
  const [bufferMinutes, setBufferMinutes] = useState<number | ''>(0)

  const [errors, setErrors] = useState<FormErrors>({})
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<ToastState | null>(null)

  const savedRef = useRef<Exam | null>(null)

  const applyExam = (exam: Exam) => {
    setTitle(exam.title)
    setDescription(exam.description ?? '')
    setDurationMinutes(exam.duration_minutes)
    setRandomizeOrder(exam.randomize_question_order)
    setCameraProctoring(exam.camera_proctoring_required)
    setViolationLimit(exam.violation_limit)
    setMaxCodeRuns(exam.max_code_runs)
    setLoginCode(exam.login_code ?? '')
    setBufferMinutes(exam.buffer_duration_minutes ?? 0)
    savedRef.current = exam
  }

  useEffect(() => {
    if (!id) return
    getExam(Number(id))
      .then(exam => { applyExam(exam); setLoading(false) })
      .catch(() => navigate('/dashboard'))
  }, [id])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setToast(null)

    const errs = validateForm(title, durationMinutes, violationLimit, maxCodeRuns, loginCode)
    setErrors(errs)
    if (Object.keys(errs).length > 0) return

    setSaving(true)
    try {
      const updated = await updateExam(Number(id), {
        title: title.trim(),
        description,
        duration_minutes: Number(durationMinutes),
        randomize_question_order: randomizeOrder,
        camera_proctoring_required: cameraProctoring,
        violation_limit: Number(violationLimit) || 0,
        max_code_runs: maxCodeRuns,
        login_code: loginCode.trim().toUpperCase(),
        buffer_duration_minutes: Number(bufferMinutes) || 0,
      })
      applyExam(updated)
      setErrors({})
      setToast({ type: 'success', message: 'Exam settings saved successfully.' })
    } catch (err) {
      setToast({
        type: 'error',
        message: extractErrorMessage(err, 'Failed to save changes. Please try again.'),
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p style={{ padding: 24, fontFamily: 'system-ui, sans-serif', color: muted }}>Loading…</p>

  return (
    <div style={{ maxWidth: 640, margin: '40px auto', padding: '0 24px 48px', fontFamily: 'system-ui, sans-serif' }}>

      {toast && <Toast toast={toast} onDismiss={() => setToast(null)} />}

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <Link to={`/exams/${id}`} style={{ color: muted, textDecoration: 'none', fontSize: 13 }}>
          ← Back to Exam
        </Link>
        <h2 style={{ margin: '8px 0 4px', fontSize: 22, fontWeight: 700, color: text }}>
          Edit Exam Settings
        </h2>
        <p style={{ margin: 0, color: muted, fontSize: 14 }}>
          Update exam details and security configuration.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate>

        {/* ── Basic Info ─────────────────────────────────────────────────── */}
        <div style={sectionStyle}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: text }}>
            Basic Information
          </h3>

          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>
              Title <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>
            </label>
            <input
              value={title}
              onChange={e => { setTitle(e.target.value); setErrors(p => ({ ...p, title: '' })) }}
              placeholder="e.g. Midterm Exam — Data Structures"
              style={inputStyle(!!errors.title)}
            />
            <FieldError message={errors.title ?? ''} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Instructions or context shown to students before they begin…"
              rows={3}
              style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          <div>
            <label style={labelStyle}>
              Duration (minutes) <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>
              <FieldHint text="The total time a student has once they open the exam. Countdown starts immediately." />
            </label>
            <input
              type="number"
              min={1}
              max={600}
              value={durationMinutes}
              onChange={e => {
                setDurationMinutes(e.target.value === '' ? '' : Number(e.target.value))
                setErrors(p => ({ ...p, duration: '' }))
              }}
              placeholder="60"
              style={{ ...inputStyle(!!errors.duration), width: 140 }}
            />
            <FieldError message={errors.duration ?? ''} />
          </div>

          <div style={{ marginTop: 14 }}>
            <label style={labelStyle}>
              Buffer Duration (minutes)
              <FieldHint text="Instructor briefing window before exam begins. Questions are hidden during buffer. Set 0 to start immediately." />
            </label>
            <input
              type="number"
              min={0}
              max={60}
              value={bufferMinutes}
              onChange={e => setBufferMinutes(e.target.value === '' ? '' : Number(e.target.value))}
              placeholder="0"
              style={{ ...inputStyle(), width: 140 }}
            />
            {Number(bufferMinutes) > 0 && (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#1d4ed8' }}>
                Students will see a {bufferMinutes}-minute countdown before questions appear.
              </p>
            )}
          </div>
        </div>

        {/* ── Security & Proctoring ──────────────────────────────────────── */}
        <div style={sectionStyle}>
          <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: text }}>
            Security & Proctoring
          </h3>
          <p style={{ margin: '0 0 18px', fontSize: 12, color: muted }}>
            Configure monitoring and delivery rules for this exam.
          </p>

          {/* Lobby PIN */}
          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>
              Lobby PIN
              <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>
              <FieldHint text="Students enter this code in the lobby to join. Min 4 characters." />
            </label>
            <input
              value={loginCode}
              onChange={e => {
                setLoginCode(e.target.value.toUpperCase().replace(/\s/g, ''))
                setErrors(p => ({ ...p, loginCode: '' }))
              }}
              placeholder="e.g. 8822 or MATH7"
              maxLength={12}
              style={{ ...inputStyle(!!errors.loginCode), width: 200, fontFamily: 'monospace', fontWeight: 700, letterSpacing: '2px', fontSize: 16 }}
            />
            <FieldError message={errors.loginCode ?? ''} />
            {loginCode && !errors.loginCode && (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#15803d' }}>
                Students will enter <strong>{loginCode}</strong> to join this exam.
              </p>
            )}
          </div>

          <Toggle
            label="Randomize Question Order"
            hint="Each student receives questions in a uniquely shuffled order, making it harder to share answers."
            checked={randomizeOrder}
            onChange={setRandomizeOrder}
            isDark={isDark}
          />

          <Toggle
            label="Camera Proctoring Required"
            hint="Requires a live webcam feed for the full duration of the test. Students without a camera cannot proceed."
            checked={cameraProctoring}
            onChange={setCameraProctoring}
            isDark={isDark}
          />

          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>
              Violation Limit
              <FieldHint text="How many times a student can leave fullscreen before being auto-submitted. Set 0 to disable." />
            </label>
            <input
              type="number"
              min={0}
              max={99}
              value={violationLimit}
              onChange={e => {
                setViolationLimit(e.target.value === '' ? '' : Number(e.target.value))
                setErrors(p => ({ ...p, violationLimit: '' }))
              }}
              style={{ ...inputStyle(!!errors.violationLimit), width: 120 }}
            />
            <FieldError message={errors.violationLimit ?? ''} />
          </div>

          <div>
            <label style={labelStyle}>
              Max Code Runs Per Question
              <FieldHint text="Set to 0 to disable code testing — students submit without being able to run their code." />
            </label>
            <select
              value={maxCodeRuns}
              onChange={e => {
                setMaxCodeRuns(Number(e.target.value))
                setErrors(p => ({ ...p, maxCodeRuns: '' }))
              }}
              style={{ ...inputStyle(!!errors.maxCodeRuns), width: 220, cursor: 'pointer' }}
            >
              <option value={0}>0 — Not Available (disabled)</option>
              <option value={1}>1 run</option>
              <option value={2}>2 runs</option>
              <option value={3}>3 runs</option>
            </select>
            <FieldError message={errors.maxCodeRuns ?? ''} />
            {maxCodeRuns === 0 && !errors.maxCodeRuns && (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#92400e' }}>
                Students will see the code editor but cannot run their code.
              </p>
            )}
          </div>
        </div>

        {/* ── Actions ────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            type="submit"
            disabled={saving}
            style={{
              padding: '10px 28px',
              background: saving ? '#93c5fd' : '#1a73e8',
              color: 'white', border: 'none', borderRadius: 6,
              fontSize: 14, fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center',
              transition: 'background 0.15s',
            }}
          >
            {saving && <Spinner />}
            {saving ? 'Saving…' : 'Save Changes'}
          </button>

          <Link to={`/exams/${id}`}>
            <button
              type="button"
              disabled={saving}
              style={{
                padding: '10px 20px',
                background: isDark ? '#334155' : 'white',
                color: isDark ? '#e2e8f0' : '#374151',
                border: `1px solid ${isDark ? '#475569' : '#d1d5db'}`,
                borderRadius: 6, fontSize: 14,
                cursor: saving ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
          </Link>
        </div>

      </form>
    </div>
  )
}
