import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import {
  type Teacher, type Exam,
  getAdminTeachers, createTeacher,
  resetTeacherPassword, setTeacherActive, deleteTeacher, getAdminTeacherExams,
  type CreateTeacherResponse,
} from '../api/client'
import { useTheme } from '../contexts/ThemeContext'

// ── Colour tokens (match the rest of the app) ─────────────────────────────────
const BLUE   = '#1a73e8'
const GREEN  = '#22c55e'
const RED    = '#ef4444'
const AMBER  = '#f59e0b'
const PURPLE = '#7c3aed'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitials(name: string) {
  return name.split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

function MiniAvatar({ name }: { name: string }) {
  const palette = [BLUE, '#0f9d58', '#f4511e', PURPLE, '#00acc1']
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffffffff
  const bg = palette[Math.abs(h) % palette.length]
  return (
    <div style={{
      width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
      background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 12, fontWeight: 700, color: 'white', letterSpacing: '0.5px',
    }}>
      {getInitials(name)}
    </div>
  )
}

// ── Inline modal wrapper ───────────────────────────────────────────────────────

function Modal({ title, onClose, children, width = 480 }: {
  title: string; onClose: () => void; children: React.ReactNode; width?: number
}) {
  const { isDark } = useTheme()
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 5000,
      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: '100%', maxWidth: width,
        background: isDark ? '#1e293b' : 'white',
        borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        border: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '18px 24px',
          borderBottom: `1px solid ${isDark ? '#334155' : '#f3f4f6'}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: isDark ? '#f1f5f9' : '#111827' }}>
            {title}
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 20, color: isDark ? '#94a3b8' : '#9ca3af', lineHeight: 1,
          }}>×</button>
        </div>
        <div style={{ padding: '24px' }}>{children}</div>
      </div>
    </div>
  )
}

// ── Temp-password display (shared by create + reset) ─────────────────────────

function TempPasswordBox({ label, value, isDark }: { label: string; value: string; isDark: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <div style={{
      background: isDark ? '#0f172a' : '#f0fdf4',
      border: `1px solid ${isDark ? '#166534' : '#bbf7d0'}`,
      borderRadius: 8, padding: '12px 14px',
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: isDark ? '#86efac' : '#15803d', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <code style={{
          flex: 1, fontSize: 18, fontWeight: 700, letterSpacing: 2,
          color: isDark ? '#f0fdf4' : '#14532d',
          fontFamily: 'monospace',
        }}>{value}</code>
        <button onClick={copy} style={{
          padding: '4px 10px', fontSize: 12, fontWeight: 600,
          background: copied ? GREEN : (isDark ? '#166534' : '#dcfce7'),
          color: copied ? 'white' : (isDark ? '#86efac' : '#15803d'),
          border: 'none', borderRadius: 5, cursor: 'pointer',
          transition: 'background 0.15s',
        }}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <div style={{ fontSize: 11, color: isDark ? '#64748b' : '#9ca3af', marginTop: 6 }}>
        Share this with the teacher — it will not be shown again.
      </div>
    </div>
  )
}

// ── Create Teacher form ────────────────────────────────────────────────────────

function CreateTeacherModal({ onClose, onCreated }: {
  onClose: () => void
  onCreated: (t: Teacher) => void
}) {
  const { isDark } = useTheme()
  const [name, setName]           = useState('')
  const [email, setEmail]         = useState('')
  const [error, setError]         = useState('')
  const [loading, setLoading]     = useState(false)
  const [result, setResult]       = useState<CreateTeacherResponse | null>(null)

  const inputSt: CSSProperties = {
    width: '100%', padding: '9px 12px', borderRadius: 7, fontSize: 14,
    border: `1px solid ${isDark ? '#475569' : '#d1d5db'}`,
    background: isDark ? '#0f172a' : 'white',
    color: isDark ? '#f1f5f9' : '#111827',
    boxSizing: 'border-box',
  }
  const labelSt: CSSProperties = {
    display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5,
    color: isDark ? '#cbd5e1' : '#374151',
  }

  const handleSubmit = async () => {
    if (!name || !email) {
      setError('Name and email are required.')
      return
    }
    setError('')
    setLoading(true)
    try {
      const res = await createTeacher({ name, email })
      setResult(res)
      onCreated(res.teacher)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Failed to create teacher.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title="Create Teacher Account" onClose={onClose}>
      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: isDark ? '#f1f5f9' : '#111827' }}>
              Account created for {result.teacher.name}
            </div>
            <div style={{ fontSize: 13, color: isDark ? '#94a3b8' : '#6b7280', marginTop: 4 }}>
              {result.teacher.email}
            </div>
          </div>
          <TempPasswordBox
            label="Temporary Password (share with teacher)"
            value={result.temp_password}
            isDark={isDark}
          />
          <p style={{ margin: 0, fontSize: 12, color: isDark ? '#94a3b8' : '#6b7280', textAlign: 'center' }}>
            The teacher will be required to set a new password on first login.
          </p>
          <button onClick={onClose} style={{
            padding: '9px 20px', background: BLUE, color: 'white',
            border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: 'pointer',
          }}>Done</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelSt}>Full Name</label>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Dr. Jane Smith" style={inputSt} />
          </div>
          <div>
            <label style={labelSt}>Email Address</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="teacher@university.edu" style={inputSt} />
          </div>
          <p style={{ margin: 0, fontSize: 12, color: isDark ? '#64748b' : '#9ca3af' }}>
            A secure temporary password will be generated automatically.
          </p>
          {error && (
            <div style={{
              background: '#fef2f2', border: '1px solid #fca5a5',
              borderRadius: 7, padding: '9px 12px', fontSize: 13, color: '#dc2626',
            }}>
              {error}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4 }}>
            <button onClick={onClose} style={{
              padding: '9px 20px', background: isDark ? '#334155' : '#f3f4f6',
              color: isDark ? '#e2e8f0' : '#374151',
              border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer',
            }}>Cancel</button>
            <button onClick={handleSubmit} disabled={loading} style={{
              padding: '9px 20px', background: loading ? '#93c5fd' : BLUE,
              color: 'white', border: 'none', borderRadius: 7, fontSize: 14,
              fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
            }}>
              {loading ? 'Creating…' : 'Create Account'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Reset Password modal ───────────────────────────────────────────────────────

function ResetPasswordModal({ teacher, onClose }: { teacher: Teacher; onClose: () => void }) {
  const { isDark } = useTheme()
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [error, setError]               = useState('')
  const [loading, setLoading]           = useState(false)

  const handleReset = async () => {
    setError('')
    setLoading(true)
    try {
      const res = await resetTeacherPassword(teacher.id)
      setTempPassword(res.temp_password)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Failed to reset password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title={`Reset Password — ${teacher.name}`} onClose={onClose}>
      {tempPassword ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: isDark ? '#f1f5f9' : '#111827' }}>
              Password reset for {teacher.name}
            </div>
          </div>
          <TempPasswordBox
            label="New Temporary Password (share with teacher)"
            value={tempPassword}
            isDark={isDark}
          />
          <p style={{ margin: 0, fontSize: 12, color: isDark ? '#94a3b8' : '#6b7280', textAlign: 'center' }}>
            The teacher will be required to set a new password on next login.
          </p>
          <button onClick={onClose} style={{
            padding: '9px 20px', background: BLUE, color: 'white',
            border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: 'pointer',
          }}>Done</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13, color: isDark ? '#94a3b8' : '#6b7280' }}>
            This will generate a new random password for <strong>{teacher.email}</strong> and
            force them to change it on next login.
          </p>
          {error && (
            <div style={{
              background: '#fef2f2', border: '1px solid #fca5a5',
              borderRadius: 7, padding: '9px 12px', fontSize: 13, color: '#dc2626',
            }}>{error}</div>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={onClose} style={{
              padding: '9px 20px', background: isDark ? '#334155' : '#f3f4f6',
              color: isDark ? '#e2e8f0' : '#374151',
              border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer',
            }}>Cancel</button>
            <button onClick={handleReset} disabled={loading} style={{
              padding: '9px 20px', background: loading ? '#93c5fd' : AMBER,
              color: 'white', border: 'none', borderRadius: 7, fontSize: 14,
              fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
            }}>
              {loading ? 'Resetting…' : 'Generate New Password'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Teacher's Exams drawer ────────────────────────────────────────────────────

function ExamsDrawer({ teacher, onClose }: { teacher: Teacher; onClose: () => void }) {
  const { isDark } = useTheme()
  const [exams, setExams] = useState<Exam[] | null>(null)

  useEffect(() => {
    getAdminTeacherExams(teacher.id)
      .then(setExams)
      .catch(() => setExams([]))
  }, [teacher.id])

  const bg     = isDark ? '#0f172a' : '#f8fafc'
  const cardBg = isDark ? '#1e293b' : 'white'
  const border = isDark ? '#334155' : '#e5e7eb'
  const text   = isDark ? '#f1f5f9' : '#111827'
  const muted  = isDark ? '#94a3b8' : '#6b7280'

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 5000,
      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end',
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: '100%', maxWidth: 560, height: '100vh', overflowY: 'auto',
        background: bg, borderLeft: `1px solid ${border}`,
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px', background: cardBg,
          borderBottom: `1px solid ${border}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          position: 'sticky', top: 0, zIndex: 10,
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: text }}>{teacher.name}'s Exams</div>
            <div style={{ fontSize: 12, color: muted }}>{teacher.email}</div>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: `1px solid ${border}`,
            borderRadius: 6, padding: '5px 10px', cursor: 'pointer', color: muted, fontSize: 18,
          }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: 20 }}>
          {exams === null ? (
            <div style={{ textAlign: 'center', padding: 40, color: muted }}>Loading…</div>
          ) : exams.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: muted }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
              No exams created yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {exams.map(exam => (
                <div key={exam.id} style={{
                  background: cardBg, border: `1px solid ${border}`,
                  borderRadius: 9, padding: '14px 16px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: text, marginBottom: 2 }}>
                      {exam.title}
                    </div>
                    <div style={{ fontSize: 12, color: muted }}>
                      {exam.duration_minutes}m
                      {exam.login_code && ` · PIN: ${exam.login_code}`}
                      {exam.is_active && (
                        <span style={{
                          marginLeft: 8, fontSize: 10, fontWeight: 700,
                          color: '#15803d', background: '#f0fdf4',
                          padding: '1px 6px', borderRadius: 9999,
                        }}>Live</span>
                      )}
                    </div>
                  </div>
                  <Link to={`/exams/${exam.id}`}>
                    <button style={{
                      padding: '5px 12px', fontSize: 12, fontWeight: 600,
                      background: BLUE, color: 'white',
                      border: 'none', borderRadius: 5, cursor: 'pointer',
                    }}>Open</button>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function AdminStaff() {
  const { isDark } = useTheme()
  const [teachers, setTeachers]       = useState<Teacher[]>([])
  const [loading, setLoading]         = useState(true)
  const [showCreate, setShowCreate]   = useState(false)
  const [resetTarget, setResetTarget] = useState<Teacher | null>(null)
  const [examsTarget, setExamsTarget] = useState<Teacher | null>(null)
  const [toggling, setToggling]       = useState<number | null>(null)
  const [deleting, setDeleting]       = useState<number | null>(null)
  const [search, setSearch]           = useState('')

  useEffect(() => {
    getAdminTeachers()
      .then(setTeachers)
      .catch(() => setTeachers([]))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return q
      ? teachers.filter(t => t.name.toLowerCase().includes(q) || t.email.toLowerCase().includes(q))
      : teachers
  }, [teachers, search])

  const handleToggleActive = useCallback(async (t: Teacher) => {
    setToggling(t.id)
    try {
      await setTeacherActive(t.id, !t.is_active)
      setTeachers(prev => prev.map(x => x.id === t.id ? { ...x, is_active: !t.is_active } : x))
    } catch { /* silent */ }
    finally { setToggling(null) }
  }, [])

  const handleDelete = useCallback(async (t: Teacher) => {
    if (!confirm(`Permanently delete ${t.name}'s account and all their exams?`)) return
    setDeleting(t.id)
    try {
      await deleteTeacher(t.id)
      setTeachers(prev => prev.filter(x => x.id !== t.id))
    } catch { /* silent */ }
    finally { setDeleting(null) }
  }, [])

  // Style tokens
  const cardBg = isDark ? '#1e293b' : 'white'
  const border = isDark ? '#334155' : '#e5e7eb'
  const text   = isDark ? '#f1f5f9' : '#111827'
  const muted  = isDark ? '#94a3b8' : '#6b7280'
  const thBg   = isDark ? '#0f172a' : '#f9fafb'

  const th: CSSProperties = {
    padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700,
    color: muted, textTransform: 'uppercase', letterSpacing: '0.4px',
    whiteSpace: 'nowrap',
  }
  const td: CSSProperties = { padding: '12px 14px', fontSize: 14, color: text }

  const active  = teachers.filter(t => t.is_active).length
  const inactive = teachers.filter(t => !t.is_active).length

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 24px 48px', fontFamily: 'system-ui, sans-serif' }}>

      {/* Modals */}
      {showCreate && (
        <CreateTeacherModal
          onClose={() => setShowCreate(false)}
          onCreated={t => setTeachers(prev => [...prev, t])}
        />
      )}
      {resetTarget && (
        <ResetPasswordModal teacher={resetTarget} onClose={() => setResetTarget(null)} />
      )}
      {examsTarget && (
        <ExamsDrawer teacher={examsTarget} onClose={() => setExamsTarget(null)} />
      )}

      {/* ── Page header ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: text }}>
            Staff Management
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: muted }}>
            Manage teacher accounts and access across the platform.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          style={{
            padding: '10px 22px', background: BLUE, color: 'white',
            border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: 'pointer',
          }}
        >
          + Add Teacher
        </button>
      </div>

      {/* ── Stat cards ────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 28 }}>
        {[
          { label: 'Total Teachers', value: teachers.length, color: BLUE },
          { label: 'Active',         value: active,          color: GREEN },
          { label: 'Inactive',       value: inactive,        color: inactive > 0 ? AMBER : muted },
        ].map(s => (
          <div key={s.label} style={{
            background: cardBg, border: `1px solid ${border}`,
            borderRadius: 10, padding: '16px 20px',
            borderLeft: `4px solid ${s.color}`,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: muted, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6 }}>
              {s.label}
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, color: s.color, lineHeight: 1 }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* ── Table card ────────────────────────────────────────────────────── */}
      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 12, overflow: 'hidden' }}>
        {/* Search + heading */}
        <div style={{
          padding: '14px 20px', borderBottom: `1px solid ${border}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: text }}>
            Teacher Accounts
            <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: muted }}>
              ({filtered.length})
            </span>
          </div>
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            style={{
              padding: '7px 12px', borderRadius: 7, fontSize: 13,
              border: `1px solid ${border}`,
              background: isDark ? '#0f172a' : '#f9fafb',
              color: text, width: 240,
            }}
          />
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: muted }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '48px 24px', textAlign: 'center', color: muted }}>
            {teachers.length === 0 ? 'No teacher accounts yet. Click "+ Add Teacher" to get started.' : 'No results match your search.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: thBg }}>
                  <th style={th}>Teacher</th>
                  <th style={th}>Email</th>
                  <th style={th}>Status</th>
                  <th style={th}>Joined</th>
                  <th style={{ ...th, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => (
                  <tr key={t.id} style={{ borderTop: `1px solid ${border}` }}>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <MiniAvatar name={t.name} />
                        <div>
                          <div style={{ fontWeight: 600 }}>{t.name}</div>
                          <div style={{ fontSize: 11, color: muted, fontFamily: 'monospace' }}>
                            ID #{t.id}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ ...td, fontSize: 13, color: muted }}>{t.email}</td>
                    <td style={td}>
                      <span style={{
                        display: 'inline-block', fontSize: 11, fontWeight: 700,
                        padding: '3px 10px', borderRadius: 9999,
                        background: t.is_active ? '#dcfce7' : '#fef3c7',
                        color: t.is_active ? '#15803d' : '#92400e',
                      }}>
                        {t.is_active ? '● Active' : '○ Inactive'}
                      </span>
                    </td>
                    <td style={{ ...td, fontSize: 12, color: muted, whiteSpace: 'nowrap' }}>
                      {new Date(t.created_at).toLocaleDateString()}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        {/* View Exams */}
                        <button
                          onClick={() => setExamsTarget(t)}
                          title="View exams"
                          style={{
                            padding: '5px 10px', fontSize: 12, fontWeight: 600,
                            background: isDark ? '#1e3a5f' : '#eff6ff',
                            color: BLUE, border: `1px solid ${isDark ? '#1e40af' : '#bfdbfe'}`,
                            borderRadius: 5, cursor: 'pointer',
                          }}
                        >
                          Exams
                        </button>
                        {/* Reset password */}
                        <button
                          onClick={() => setResetTarget(t)}
                          title="Reset password"
                          style={{
                            padding: '5px 10px', fontSize: 12, fontWeight: 600,
                            background: isDark ? '#451a03' : '#fffbeb',
                            color: AMBER, border: `1px solid ${isDark ? '#92400e' : '#fde68a'}`,
                            borderRadius: 5, cursor: 'pointer',
                          }}
                        >
                          Reset PW
                        </button>
                        {/* Activate / Deactivate */}
                        <button
                          onClick={() => handleToggleActive(t)}
                          disabled={toggling === t.id}
                          title={t.is_active ? 'Deactivate account' : 'Activate account'}
                          style={{
                            padding: '5px 10px', fontSize: 12, fontWeight: 600,
                            background: t.is_active
                              ? (isDark ? '#422006' : '#fef3c7')
                              : (isDark ? '#14532d' : '#f0fdf4'),
                            color: t.is_active ? AMBER : GREEN,
                            border: `1px solid ${t.is_active ? (isDark ? '#92400e' : '#fde68a') : (isDark ? '#166534' : '#bbf7d0')}`,
                            borderRadius: 5, cursor: toggling === t.id ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {toggling === t.id ? '…' : t.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                        {/* Delete */}
                        <button
                          onClick={() => handleDelete(t)}
                          disabled={deleting === t.id}
                          title="Delete account permanently"
                          style={{
                            padding: '5px 10px', fontSize: 12, fontWeight: 600,
                            background: isDark ? '#450a0a' : '#fef2f2',
                            color: RED, border: `1px solid ${isDark ? '#991b1b' : '#fca5a5'}`,
                            borderRadius: 5, cursor: deleting === t.id ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {deleting === t.id ? '…' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
