import { useState, type FormEvent, type CSSProperties } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { getPublicExam } from '../api/client'

// ── Error messages ────────────────────────────────────────────────────────────

const ERROR_MESSAGES: Record<string, string> = {
  invalid:  'Please enter a valid numeric exam code.',
  notfound: 'No exam found with that code. Please check and try again.',
  inactive: 'This exam is not currently open. Please wait for your instructor to start the session.',
  network:  'Unable to reach the server. Check your connection and try again.',
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function StudentJoin() {
  const navigate = useNavigate()
  const [code,     setCode]     = useState('')
  const [checking, setChecking] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    const trimmed = code.trim()
    const num = Number(trimmed)
    if (!trimmed || !Number.isInteger(num) || num <= 0) {
      setErrorKey('invalid')
      return
    }

    setChecking(true)
    setErrorKey(null)

    try {
      // A 200 response means the exam exists AND is active.
      // 403 → inactive, 404 → not found.
      await getPublicExam(num)
      navigate(`/take/${num}`)
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 403)      setErrorKey('inactive')
      else if (status === 404) setErrorKey('notfound')
      else                     setErrorKey('network')
    } finally {
      setChecking(false)
    }
  }

  const hasError = errorKey !== null

  const inputStyle: CSSProperties = {
    width: '100%',
    padding: '14px 16px',
    border: `1.5px solid ${hasError ? '#dc2626' : 'var(--input-border)'}`,
    borderRadius: 8,
    fontSize: 28,
    fontWeight: 700,
    textAlign: 'center',
    letterSpacing: '6px',
    boxSizing: 'border-box',
    outline: hasError ? '3px solid #fca5a5' : 'none',
    outlineOffset: 2,
    color: 'var(--text)',
    background: 'var(--input-bg)',
    fontFamily: 'monospace',
    transition: 'border-color 0.15s, outline 0.15s',
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--page-bg)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: '24px',
    }}>
      <div style={{
        width: '100%', maxWidth: 440,
        background: 'var(--card-bg)', borderRadius: 16,
        border: '1px solid var(--border)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.08)',
        padding: 40,
      }}>

        {/* Back link */}
        <Link
          to="/"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            color: 'var(--text-muted)', textDecoration: 'none', fontSize: 13, fontWeight: 500,
            marginBottom: 28,
          }}
        >
          ← Back to Home
        </Link>

        {/* Icon + heading */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 52, marginBottom: 16, lineHeight: 1 }}>📝</div>
          <h2 style={{ margin: '0 0 8px', fontSize: 24, fontWeight: 800, color: 'var(--text)' }}>
            Join an Exam
          </h2>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Enter the exam code your instructor shared with you.
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          {/* Code input */}
          <div style={{ marginBottom: 16 }}>
            <label style={{
              display: 'block', fontSize: 12, fontWeight: 700,
              color: 'var(--text)', letterSpacing: '0.5px', textTransform: 'uppercase',
              marginBottom: 8,
            }}>
              Exam Code
            </label>
            <input
              value={code}
              onChange={e => {
                // Allow only digits
                const val = e.target.value.replace(/\D/g, '')
                setCode(val)
                if (errorKey) setErrorKey(null)
              }}
              placeholder="—"
              autoFocus
              inputMode="numeric"
              maxLength={8}
              style={inputStyle}
            />
          </div>

          {/* Error message */}
          {hasError && errorKey && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              background: '#fef2f2', border: '1px solid #fca5a5',
              borderRadius: 8, padding: '10px 14px', marginBottom: 16,
            }}>
              <span style={{ color: '#dc2626', flexShrink: 0, marginTop: 1 }}>⚠</span>
              <p style={{ margin: 0, fontSize: 13, color: '#dc2626', lineHeight: 1.5 }}>
                {ERROR_MESSAGES[errorKey]}
              </p>
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={checking || !code.trim()}
            style={{
              width: '100%', padding: '13px 0',
              background: checking || !code.trim() ? '#9ca3af' : '#0f9d58',
              color: 'white', border: 'none', borderRadius: 8,
              fontSize: 15, fontWeight: 700,
              cursor: checking || !code.trim() ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {checking ? (
              <>
                <Spinner /> Verifying…
              </>
            ) : (
              'Verify & Continue →'
            )}
          </button>
        </form>

        {/* Helper note */}
        <p style={{
          margin: '20px 0 0', fontSize: 12, color: 'var(--text-muted)',
          textAlign: 'center', lineHeight: 1.5,
        }}>
          The exam code is the number your instructor displayed.<br />
          Contact them if you don't have it.
        </p>
      </div>
    </div>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <>
      <style>{`
        @keyframes sjoin-spin { to { transform: rotate(360deg); } }
        .sjoin-spinner {
          display: inline-block; width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.4);
          border-top-color: white; border-radius: 50%;
          animation: sjoin-spin 0.7s linear infinite;
          vertical-align: middle;
        }
      `}</style>
      <span className="sjoin-spinner" />
    </>
  )
}
