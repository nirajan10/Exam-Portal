import { useState, FormEvent, type CSSProperties } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { createExam } from '../api/client'
import { useTheme } from '../contexts/ThemeContext'

const mkSection = (isDark: boolean): CSSProperties => ({
  background: isDark ? '#1e293b' : '#f9fafb',
  border: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
  borderRadius: 8,
  padding: 20,
  marginBottom: 20,
})

// ── FieldHint — italic side-label that explains the impact of a field ─────────

function FieldHint({ text }: { text: string }) {
  return (
    <span style={{
      fontSize: 11,
      color: '#6b7280',
      fontStyle: 'italic',
      marginLeft: 6,
      fontWeight: 400,
    }}>
      {text}
    </span>
  )
}

// ── FieldError — shown below an input when validation fails ───────────────────

function FieldError({ message }: { message: string }) {
  if (!message) return null
  return (
    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#dc2626', display: 'flex', alignItems: 'center', gap: 4 }}>
      <span>⚠</span> {message}
    </p>
  )
}

// ── inputStyle — applies red border when there is an error ───────────────────

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

const mkLabel = (isDark: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'baseline',
  fontSize: 13,
  fontWeight: 600,
  color: isDark ? '#cbd5e1' : '#374151',
  marginBottom: 2,
})

// ── Toggle ────────────────────────────────────────────────────────────────────

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
        <div style={{ fontWeight: 600, fontSize: 14, color: isDark ? '#f1f5f9' : '#111827' }}>
          {label}
        </div>
        <div style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#6b7280', marginTop: 2, fontStyle: 'italic' }}>
          {hint}
        </div>
      </div>
    </div>
  )
}

// ── Main form ─────────────────────────────────────────────────────────────────

interface FormErrors {
  title?: string
  duration?: string
  violationLimit?: string
  loginCode?: string
}

export default function ExamCreate() {
  const navigate = useNavigate()
  const { isDark } = useTheme()

  const sectionStyle = mkSection(isDark)
  const labelStyle   = mkLabel(isDark)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [durationMinutes, setDurationMinutes] = useState<number | ''>(60)

  const [randomizeOrder, setRandomizeOrder] = useState(false)
  const [cameraProctoring, setCameraProctoring] = useState(false)
  const [violationLimit, setViolationLimit] = useState<number | ''>(0)
  const [maxCodeRuns, setMaxCodeRuns] = useState(0)
  const [loginCode, setLoginCode] = useState('')

  const [errors, setErrors] = useState<FormErrors>({})
  const [submitError, setSubmitError] = useState('')
  const [saving, setSaving] = useState(false)

  // Returns a populated errors object; empty object means valid.
  const validate = (): FormErrors => {
    const e: FormErrors = {}
    if (!title.trim()) e.title = 'Title is required.'
    if (durationMinutes === '' || Number(durationMinutes) <= 0) {
      e.duration = 'Duration must be a positive number (e.g. 60 for one hour).'
    } else if (Number(durationMinutes) > 600) {
      e.duration = 'Duration cannot exceed 600 minutes (10 hours).'
    }
    if (violationLimit !== '' && Number(violationLimit) < 0) {
      e.violationLimit = 'Violation limit cannot be negative.'
    }
    if (loginCode.trim() && loginCode.trim().length < 4) {
      e.loginCode = 'PIN must be at least 4 characters.'
    }
    return e
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitError('')

    const errs = validate()
    setErrors(errs)
    if (Object.keys(errs).length > 0) return

    setSaving(true)
    try {
      const exam = await createExam({
        title: title.trim(),
        description,
        duration_minutes: Number(durationMinutes),
        randomize_question_order: randomizeOrder,
        camera_proctoring_required: cameraProctoring,
        violation_limit: Number(violationLimit) || 0,
        max_code_runs: maxCodeRuns,
        login_code: loginCode.trim().toUpperCase(),
      })
      navigate(`/exams/${exam.id}`)
    } catch {
      setSubmitError('Failed to create exam. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: '40px auto', padding: '0 24px 48px', fontFamily: 'system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <Link to="/dashboard" style={{ color: isDark ? '#94a3b8' : '#6b7280', textDecoration: 'none', fontSize: 13 }}>
          ← Back to Dashboard
        </Link>
        <h2 style={{ margin: '8px 0 4px', fontSize: 22, fontWeight: 700, color: isDark ? '#f1f5f9' : '#111827' }}>
          Create New Exam
        </h2>
        <p style={{ margin: 0, color: isDark ? '#94a3b8' : '#6b7280', fontSize: 14 }}>
          Set up exam details and configure security settings.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate>

        {/* ── Basic Info ─────────────────────────────────────────────────── */}
        <div style={sectionStyle}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: isDark ? '#f1f5f9' : '#111827' }}>
            Basic Information
          </h3>

          {/* Title */}
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>
              Title <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>
            </label>
            <input
              value={title}
              onChange={e => { setTitle(e.target.value); setErrors(prev => ({ ...prev, title: '' })) }}
              placeholder="e.g. Midterm Exam — Data Structures"
              style={inputStyle(!!errors.title)}
            />
            <FieldError message={errors.title ?? ''} />
          </div>

          {/* Description */}
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

          {/* Duration */}
          <div>
            <label style={labelStyle}>
              Duration (minutes) <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>
              <FieldHint text="The total time a student has once they click Start. The countdown begins immediately." />
            </label>
            <input
              type="number"
              min={1}
              max={600}
              value={durationMinutes}
              onChange={e => {
                setDurationMinutes(e.target.value === '' ? '' : Number(e.target.value))
                setErrors(prev => ({ ...prev, duration: '' }))
              }}
              placeholder="60"
              style={{ ...inputStyle(!!errors.duration), width: 140 }}
            />
            <FieldError message={errors.duration ?? ''} />
          </div>
        </div>

        {/* ── Security & Proctoring ──────────────────────────────────────── */}
        <div style={sectionStyle}>
          <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: isDark ? '#f1f5f9' : '#111827' }}>
            Security & Proctoring
          </h3>
          <p style={{ margin: '0 0 18px', fontSize: 12, color: isDark ? '#94a3b8' : '#6b7280' }}>
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
                setErrors(prev => ({ ...prev, loginCode: '' }))
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

          {/* Randomize */}
          <Toggle
            label="Randomize Question Order"
            hint="Each student receives questions in a uniquely shuffled order, making it harder to share answers."
            checked={randomizeOrder}
            onChange={setRandomizeOrder}
            isDark={isDark}
          />

          {/* Camera */}
          <Toggle
            label="Camera Proctoring Required"
            hint="Requires a live webcam feed for the full duration of the test. Students without a camera cannot proceed."
            checked={cameraProctoring}
            onChange={setCameraProctoring}
            isDark={isDark}
          />

          {/* Violation Limit */}
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>
              Violation Limit
              <FieldHint text="How many times a student can leave fullscreen before being auto-submitted. Set to 0 to disable." />
            </label>
            <input
              type="number"
              min={0}
              max={99}
              value={violationLimit}
              onChange={e => {
                setViolationLimit(e.target.value === '' ? '' : Number(e.target.value))
                setErrors(prev => ({ ...prev, violationLimit: '' }))
              }}
              style={{ ...inputStyle(!!errors.violationLimit), width: 120 }}
            />
            <FieldError message={errors.violationLimit ?? ''} />
          </div>

          {/* Max Code Runs */}
          <div>
            <label style={labelStyle}>
              Max Code Runs Per Question
              <FieldHint text="Set to 0 to disable code testing — students must submit their first draft without running it." />
            </label>
            <select
              value={maxCodeRuns}
              onChange={e => setMaxCodeRuns(Number(e.target.value))}
              style={{ ...inputStyle(), width: 200, cursor: 'pointer' }}
            >
              <option value={0}>0 — Not Available (disabled)</option>
              <option value={1}>1 run</option>
              <option value={2}>2 runs</option>
              <option value={3}>3 runs</option>
            </select>
            {maxCodeRuns === 0 && (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#92400e' }}>
                Students will see the code editor but the Run button will be hidden.
              </p>
            )}
          </div>
        </div>

        {/* Submit */}
        {submitError && (
          <p style={{ color: '#dc2626', fontSize: 14, marginBottom: 12 }}>⚠ {submitError}</p>
        )}

        <div style={{ display: 'flex', gap: 12 }}>
          <button
            type="submit"
            disabled={saving}
            style={{
              padding: '10px 28px',
              background: saving ? '#9ca3af' : '#1a73e8',
              color: 'white', border: 'none', borderRadius: 6,
              fontSize: 14, fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Creating…' : 'Create Exam'}
          </button>
          <Link to="/dashboard">
            <button type="button" style={{
              padding: '10px 20px',
              background: isDark ? '#334155' : 'white',
              color: isDark ? '#e2e8f0' : '#374151',
              border: `1px solid ${isDark ? '#475569' : '#d1d5db'}`,
              borderRadius: 6, fontSize: 14, cursor: 'pointer',
            }}>
              Cancel
            </button>
          </Link>
        </div>
      </form>
    </div>
  )
}
