import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getExams, deleteExam, Exam } from '../api/client'
import { useTheme } from '../contexts/ThemeContext'

function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return '00:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function SecurityBadges({ exam }: { exam: Exam }) {
  const badges = [
    exam.randomize_question_order && { label: '⇄ Randomized', bg: '#e0e7ff', color: '#3730a3' },
    exam.camera_proctoring_required && { label: '📷 Camera', bg: '#fce7f3', color: '#9d174d' },
    exam.violation_limit > 0 && { label: `⚠ Limit ${exam.violation_limit}`, bg: '#fef3c7', color: '#78350f' },
    exam.max_code_runs > 0 && { label: `▶ ${exam.max_code_runs} run${exam.max_code_runs > 1 ? 's' : ''}`, bg: '#dcfce7', color: '#14532d' },
  ].filter(Boolean) as { label: string; bg: string; color: string }[]

  if (badges.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
      {badges.map(b => (
        <span key={b.label} style={{
          fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 9999,
          background: b.bg, color: b.color,
        }}>
          {b.label}
        </span>
      ))}
    </div>
  )
}

function ExamCard({ exam, onDelete, isDark }: { exam: Exam; onDelete: () => void; isDark: boolean }) {
  const qCount = exam.question_sets?.flatMap(qs => qs.questions ?? []).length ?? 0
  const setCount = exam.question_sets?.length ?? 0
  const [copied, setCopied] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null)

  useEffect(() => {
    if (!exam.is_active || !exam.started_at) { setTimeRemaining(null); return }
    const computeSecs = () => {
      const t0 = new Date(exam.started_at!).getTime()
      const bufferMs = (exam.buffer_duration_minutes ?? 0) * 60_000
      const examEnd = t0 + bufferMs + exam.duration_minutes * 60_000
      return Math.max(0, Math.ceil((examEnd - Date.now()) / 1000))
    }
    setTimeRemaining(computeSecs())
    const interval = setInterval(() => setTimeRemaining(computeSecs()), 1000)
    return () => clearInterval(interval)
  }, [exam.is_active, exam.started_at, exam.buffer_duration_minutes, exam.duration_minutes])

  const copyPin = () => {
    if (!exam.login_code) return
    navigator.clipboard.writeText(exam.login_code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const cardBg  = isDark ? '#1e293b' : 'white'
  const border  = exam.is_active
    ? (isDark ? '#166534' : '#86efac')
    : (isDark ? '#334155' : '#e5e7eb')
  const text    = isDark ? '#f1f5f9' : '#111827'
  const muted   = isDark ? '#94a3b8' : '#6b7280'
  const veryMuted = isDark ? '#64748b' : '#9ca3af'

  return (
    <div style={{
      border: `1px solid ${border}`,
      borderRadius: 8, padding: '16px 20px',
      marginBottom: 12, background: cardBg,
      boxShadow: exam.is_active ? `0 0 0 3px ${isDark ? 'rgba(34,197,94,0.12)' : 'rgba(34,197,94,0.08)'}` : 'none',
      transition: 'background 0.2s, border-color 0.2s',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>

          {/* Title row with status pill */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <Link to={`/exams/${exam.id}`} style={{ textDecoration: 'none' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: text }}>
                {exam.title}
              </h3>
            </Link>
            {exam.is_active && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 10, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase',
                color: '#15803d', background: '#f0fdf4', border: '1px solid #86efac',
                borderRadius: 9999, padding: '2px 8px', flexShrink: 0,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                Live
              </span>
            )}
            {exam.is_active && timeRemaining !== null && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 11, fontWeight: 600,
                color: timeRemaining <= 300 ? '#dc2626' : (isDark ? '#e2e8f0' : '#374151'),
                background: timeRemaining <= 300 ? '#fef2f2' : (isDark ? '#1e293b' : '#f3f4f6'),
                border: `1px solid ${timeRemaining <= 300 ? '#fca5a5' : (isDark ? '#475569' : '#e5e7eb')}`,
                borderRadius: 9999, padding: '2px 8px',
                fontFamily: 'monospace', letterSpacing: '0.5px', flexShrink: 0,
              }}>
                {timeRemaining > 0 ? `⏱ ${formatTimeRemaining(timeRemaining)}` : '⏱ Ending…'}
              </span>
            )}
          </div>

          {exam.description && (
            <p style={{ margin: '0 0 8px', fontSize: 13, color: muted }}>{exam.description}</p>
          )}

          <SecurityBadges exam={exam} />

          {/* PIN display */}
          {exam.login_code ? (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 10,
              background: exam.is_active
                ? (isDark ? '#1c1a05' : '#fefce8')
                : (isDark ? '#0f172a' : '#f9fafb'),
              border: `1px solid ${exam.is_active ? (isDark ? '#854d0e' : '#fde047') : (isDark ? '#334155' : '#e5e7eb')}`,
              borderRadius: 6, padding: '5px 10px', marginBottom: 8,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#78350f', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Class PIN
              </span>
              <span style={{
                fontFamily: 'monospace', fontSize: 18, fontWeight: 900,
                letterSpacing: '3px',
                color: exam.is_active ? '#92400e' : (isDark ? '#e2e8f0' : '#374151'),
              }}>
                {exam.login_code}
              </span>
              <button
                onClick={copyPin}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 12, color: copied ? '#15803d' : muted, fontWeight: 600,
                  padding: '2px 4px',
                }}
                title="Copy PIN"
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          ) : (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: '#fef2f2', border: '1px solid #fca5a5',
              borderRadius: 6, padding: '5px 10px', marginBottom: 8,
              fontSize: 12, color: '#dc2626', fontWeight: 500,
            }}>
              ⚠ No PIN set — students cannot join this exam
            </div>
          )}

          <div style={{ fontSize: 12, color: veryMuted }}>
            {setCount} set{setCount !== 1 ? 's' : ''} · {qCount} question{qCount !== 1 ? 's' : ''}
            {' · '}{exam.duration_minutes} min
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginLeft: 12, flexShrink: 0 }}>
          <Link to={`/exams/${exam.id}`}>
            <button style={{
              padding: '6px 14px', background: '#1a73e8', color: 'white',
              border: 'none', borderRadius: 5, fontSize: 13, cursor: 'pointer', fontWeight: 500,
            }}>
              Open
            </button>
          </Link>
          <button
            onClick={onDelete}
            style={{
              padding: '6px 12px',
              background: isDark ? '#450a0a' : '#fee2e2',
              color: '#dc2626',
              border: 'none', borderRadius: 5, fontSize: 13, cursor: 'pointer',
            }}
            title="Delete exam"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const { isDark } = useTheme()
  const [exams, setExams] = useState<Exam[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getExams()
      .then(setExams)
      .catch(() => setExams([]))
      .finally(() => setLoading(false))
  }, [])

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this exam and all its content?')) return
    await deleteExam(id)
    setExams(prev => prev.filter(e => e.id !== id))
  }

  const text  = isDark ? '#f1f5f9' : '#111827'
  const muted = isDark ? '#94a3b8' : '#6b7280'

  return (
    <div style={{ maxWidth: 820, margin: '40px auto', padding: '0 24px 48px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 700, color: text }}>My Exams</h2>
          <p style={{ margin: 0, fontSize: 13, color: muted }}>
            {exams.length} exam{exams.length !== 1 ? 's' : ''} total
          </p>
        </div>
        <Link to="/exams/new">
          <button style={{
            padding: '9px 20px', background: '#1a73e8', color: 'white',
            border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer',
          }}>
            + New Exam
          </button>
        </Link>
      </div>

      {loading && <p style={{ color: muted }}>Loading…</p>}
      {!loading && exams.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '48px 24px',
          border: `2px dashed ${isDark ? '#334155' : '#e5e7eb'}`,
          borderRadius: 10, color: muted,
        }}>
          <p style={{ fontSize: 16, marginBottom: 8 }}>No exams yet.</p>
          <Link to="/exams/new">
            <button style={{
              padding: '9px 20px', background: '#1a73e8', color: 'white',
              border: 'none', borderRadius: 6, fontSize: 14, cursor: 'pointer',
            }}>
              Create your first exam
            </button>
          </Link>
        </div>
      )}

      {exams.map(exam => (
        <ExamCard key={exam.id} exam={exam} isDark={isDark} onDelete={() => handleDelete(exam.id)} />
      ))}
    </div>
  )
}
