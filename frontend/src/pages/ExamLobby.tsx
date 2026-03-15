import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { getActiveExams, verifyPin, ActiveExam } from '../api/client'
import { useTheme } from '../contexts/ThemeContext'

// ── sessionStorage key ────────────────────────────────────────────────────────

export const accessTokenKey = (examId: number) => `exam_access_${examId}`

// ── Shared style helpers ──────────────────────────────────────────────────────

const cardBase: CSSProperties = {
  borderRadius: 12,
  padding: '20px 24px',
  boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
  textAlign: 'left',
}

// ── Exam card ─────────────────────────────────────────────────────────────────

function ExamCard({ exam, onJoin, isDark }: { exam: ActiveExam; onJoin: () => void; isDark: boolean }) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={onJoin}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...cardBase,
        background: isDark ? '#1e293b' : 'white',
        border: `1px solid ${hovered ? '#1a73e8' : (isDark ? '#334155' : '#e2e8f0')}`,
        boxShadow: hovered ? '0 8px 24px rgba(26,115,232,0.12)' : '0 2px 8px rgba(0,0,0,0.05)',
        transform: hovered ? 'translateY(-2px)' : 'none',
      }}
    >
      {/* Live badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: 10, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase',
          color: '#15803d', background: '#f0fdf4', border: '1px solid #86efac',
          borderRadius: 9999, padding: '3px 9px',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'pulse 2s infinite' }} />
          Live
        </div>
        <div style={{ fontSize: 13, color: '#6b7280', fontWeight: 500 }}>
          {exam.duration_minutes} min
        </div>
      </div>

      {/* Title */}
      <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700, color: isDark ? '#f1f5f9' : '#0f172a', lineHeight: 1.3 }}>
        {exam.title}
      </h3>

      {/* Teacher name */}
      <p style={{ margin: '0 0 12px', fontSize: 13, color: isDark ? '#94a3b8' : '#64748b' }}>
        by {exam.teacher_name}
      </p>

      {/* Description */}
      {exam.description && (
        <p style={{
          margin: '0 0 14px', fontSize: 13, color: isDark ? '#94a3b8' : '#475569', lineHeight: 1.5,
          overflow: 'hidden', maxHeight: '3em',
        }}>
          {exam.description}
        </p>
      )}

      {/* CTA */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5,
        fontSize: 13, fontWeight: 700, color: hovered ? '#1a73e8' : (isDark ? '#cbd5e1' : '#374151'),
        transition: 'color 0.15s',
      }}>
        Enter PIN to join <span style={{ fontSize: 15 }}>→</span>
      </div>
    </div>
  )
}

// ── PIN Modal ─────────────────────────────────────────────────────────────────

interface PinModalProps {
  exam: ActiveExam
  onSuccess: (token: string) => void
  onClose: () => void
  isDark: boolean
}

function PinModal({ exam, onSuccess, onClose, isDark }: PinModalProps) {
  const [pin, setPin] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-focus the PIN input when the modal opens
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!pin.trim()) return
    setChecking(true)
    setError('')
    try {
      const { access_token } = await verifyPin(exam.id, pin.trim())
      onSuccess(access_token)
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      const msg    = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      // 403 covers both wrong PIN (new backend response) and inactive exam.
      // Use the server message when available; fall back to a generic hint.
      if (status === 403 || status === 401) {
        setError(msg ?? 'Incorrect PIN. Please double-check and try again.')
      } else {
        setError(msg ?? 'Unable to verify PIN. Check your connection and try again.')
      }
      setPin('')
      inputRef.current?.focus()
    } finally {
      setChecking(false)
    }
  }

  const hasError = !!error

  return (
    /* Backdrop */
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        backdropFilter: 'blur(4px)',
      }}
    >
      {/* Modal panel — stop propagation so clicking inside doesn't close */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: isDark ? '#1e293b' : 'white', borderRadius: 16,
          padding: 36, width: '100%', maxWidth: 400,
          boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
          border: isDark ? '1px solid #334155' : 'none',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: isDark ? '#94a3b8' : '#64748b', marginBottom: 4 }}>
              Joining exam
            </div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: isDark ? '#f1f5f9' : '#0f172a', lineHeight: 1.2 }}>
              {exam.title}
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: isDark ? '#94a3b8' : '#64748b' }}>
              {exam.duration_minutes} min · by {exam.teacher_name}
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: isDark ? '#334155' : '#f1f5f9', border: 'none', borderRadius: 7,
              width: 32, height: 32, cursor: 'pointer', fontSize: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: isDark ? '#94a3b8' : '#64748b', flexShrink: 0, marginLeft: 12,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: isDark ? '#cbd5e1' : '#374151', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 8 }}>
            Exam PIN
          </label>
          <input
            ref={inputRef}
            value={pin}
            onChange={e => { setPin(e.target.value.toUpperCase()); setError('') }}
            placeholder="e.g. 8822 or MATH7"
            maxLength={12}
            autoComplete="off"
            style={{
              width: '100%', padding: '13px 14px',
              border: `1.5px solid ${hasError ? '#dc2626' : (isDark ? '#475569' : '#d1d5db')}`,
              borderRadius: 8, fontSize: 22, fontWeight: 700,
              textAlign: 'center', letterSpacing: '4px',
              fontFamily: 'monospace', boxSizing: 'border-box',
              outline: hasError ? '3px solid #fca5a5' : 'none',
              outlineOffset: 2,
              color: isDark ? '#f1f5f9' : '#111827',
              background: isDark ? '#0f172a' : 'white',
              transition: 'border-color 0.15s, outline 0.15s',
            }}
          />

          {hasError && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 7,
              background: '#fef2f2', border: '1px solid #fca5a5',
              borderRadius: 7, padding: '9px 12px', marginTop: 10,
            }}>
              <span style={{ color: '#dc2626', flexShrink: 0 }}>⚠</span>
              <p style={{ margin: 0, fontSize: 13, color: '#dc2626', lineHeight: 1.4 }}>{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={checking || !pin.trim()}
            style={{
              marginTop: 16, width: '100%', padding: '13px 0',
              background: checking || !pin.trim() ? '#9ca3af' : '#1a73e8',
              color: 'white', border: 'none', borderRadius: 8,
              fontSize: 15, fontWeight: 700,
              cursor: checking || !pin.trim() ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {checking ? <><ModalSpinner /> Verifying…</> : 'Join Exam →'}
          </button>
        </form>

        <p style={{ margin: '14px 0 0', fontSize: 12, color: isDark ? '#64748b' : '#94a3b8', textAlign: 'center' }}>
          PIN is case-insensitive. Ask your instructor if you don't have it.
        </p>
      </div>
    </div>
  )
}

function ModalSpinner() {
  return (
    <>
      <style>{`
        @keyframes lobby-spin { to { transform: rotate(360deg); } }
        .lobby-spinner {
          display: inline-block; width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.4); border-top-color: white;
          border-radius: 50%; animation: lobby-spin 0.7s linear infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; } 50% { opacity: 0.4; }
        }
      `}</style>
      <span className="lobby-spinner" />
    </>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ExamLobby() {
  const navigate = useNavigate()
  const { isDark, toggleTheme } = useTheme()
  const [exams,   setExams]   = useState<ActiveExam[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ActiveExam | null>(null)

  // Poll every 15 s so the list stays fresh without a full page reload.
  useEffect(() => {
    const load = () =>
      getActiveExams()
        .then(setExams)
        .catch(() => {})
        .finally(() => setLoading(false))

    load()
    const interval = setInterval(load, 15_000)
    return () => clearInterval(interval)
  }, [])

  const handlePinSuccess = (examId: number, token: string) => {
    sessionStorage.setItem(accessTokenKey(examId), token)
    navigate(`/take/${examId}`)
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: isDark ? '#0f172a' : '#f8fafc',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      transition: 'background 0.2s',
    }}>

      {/* PIN modal */}
      {selected && (
        <PinModal
          exam={selected}
          onSuccess={token => handlePinSuccess(selected.id, token)}
          onClose={() => setSelected(null)}
          isDark={isDark}
        />
      )}

      {/* Sticky header */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: isDark ? 'rgba(15,23,42,0.9)' : 'rgba(248,250,252,0.9)',
        backdropFilter: 'blur(12px)',
        borderBottom: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
        padding: '0 24px', height: 56,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/" style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            color: isDark ? '#94a3b8' : '#64748b', textDecoration: 'none', fontSize: 13, fontWeight: 500,
          }}>
            ← Home
          </Link>
          <span style={{ color: isDark ? '#334155' : '#cbd5e1' }}>|</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: isDark ? '#f1f5f9' : '#0f172a' }}>
            Live Exam Lobby
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: isDark ? '#64748b' : '#64748b' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
            Refreshes automatically
          </div>
          <button
            onClick={toggleTheme}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: isDark ? '#1e293b' : '#f1f5f9',
              border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
              borderRadius: 20, padding: '4px 10px',
              cursor: 'pointer', fontSize: 12, fontWeight: 500,
              color: isDark ? '#e2e8f0' : '#374151',
            }}
          >
            <span>{isDark ? '☀️' : '🌙'}</span>
            {isDark ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 900, margin: '0 auto', padding: '36px 24px 64px' }}>

        {/* Page title */}
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ margin: '0 0 8px', fontSize: 28, fontWeight: 800, color: isDark ? '#f1f5f9' : '#0f172a', letterSpacing: '-0.5px' }}>
            Active Exams
          </h1>
          <p style={{ margin: 0, fontSize: 15, color: isDark ? '#94a3b8' : '#64748b' }}>
            Click an exam card, enter the PIN given by your instructor, and you're in.
          </p>
        </div>

        {/* Loading state */}
        {loading && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {[1, 2, 3].map(i => (
              <div key={i} style={{
                ...cardBase, cursor: 'default',
                background: '#f1f5f9', border: '1px solid #e2e8f0',
                minHeight: 160, animation: 'shimmer 1.5s infinite',
              }} />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && exams.length === 0 && (
          <div style={{
            textAlign: 'center', padding: '64px 24px',
            border: `2px dashed ${isDark ? '#334155' : '#e2e8f0'}`, borderRadius: 12,
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
            <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: isDark ? '#e2e8f0' : '#374151' }}>
              No exams are open right now
            </h3>
            <p style={{ margin: 0, fontSize: 14, color: isDark ? '#64748b' : '#94a3b8', lineHeight: 1.5 }}>
              Exams appear here when your instructor starts them.<br />
              This page refreshes automatically — no need to reload.
            </p>
          </div>
        )}

        {/* Exam grid */}
        {!loading && exams.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}>
            {exams.map(exam => (
              <ExamCard
                key={exam.id}
                exam={exam}
                onJoin={() => setSelected(exam)}
                isDark={isDark}
              />
            ))}
          </div>
        )}
      </main>

      <style>{`
        @keyframes shimmer {
          0%, 100% { opacity: 1; } 50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  )
}
