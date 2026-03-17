import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { listAllFeedback, deleteFeedback, type Feedback, type FeedbackType } from '../api/client'
import { useTheme } from '../contexts/ThemeContext'

// ── Colour tokens ────────────────────────────────────────────────────────────
const BLUE   = '#1a73e8'
const RED    = '#ef4444'
const AMBER  = '#f59e0b'
const PURPLE = '#8b5cf6'
const GRAY   = '#6b7280'

const TYPE_META: Record<FeedbackType, { label: string; color: string }> = {
  bug:         { label: 'Bug Report',        color: RED },
  suggestion:  { label: 'Feature Suggestion', color: BLUE },
  usability:   { label: 'Usability Issue',    color: AMBER },
  performance: { label: 'Performance Issue',  color: PURPLE },
  other:       { label: 'Other',              color: GRAY },
}

const ALL_TYPES: FeedbackType[] = ['bug', 'suggestion', 'usability', 'performance', 'other']

// ── Detail modal ─────────────────────────────────────────────────────────────

function DetailModal({ fb, onClose, onDelete }: { fb: Feedback; onClose: () => void; onDelete: (id: number) => void }) {
  const meta = TYPE_META[fb.type] ?? TYPE_META.other
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async () => {
    if (!window.confirm('Delete this feedback entry?')) return
    setDeleting(true)
    try {
      await deleteFeedback(fb.id)
      onDelete(fb.id)
      onClose()
    } catch { /* silent */ }
    finally { setDeleting(false) }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'white', borderRadius: 14, width: 560, maxWidth: '90vw',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)', overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{
                padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                background: `${meta.color}15`, color: meta.color, border: `1px solid ${meta.color}40`,
              }}>
                {meta.label}
              </span>
            </div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>{fb.subject}</h3>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af', padding: 0, lineHeight: 1 }}
          >
            &times;
          </button>
        </div>
        <div style={{ padding: '20px 24px' }}>
          <p style={{ margin: '0 0 16px', fontSize: 14, color: '#374151', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
            {fb.body}
          </p>
          <div style={{ fontSize: 12, color: '#9ca3af', display: 'flex', gap: 16 }}>
            <span>By <strong style={{ color: '#374151' }}>{fb.teacher?.name ?? 'Unknown'}</strong> ({fb.teacher?.email})</span>
            <span>{new Date(fb.created_at).toLocaleString()}</span>
          </div>
        </div>
        <div style={{ padding: '12px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              padding: '8px 18px', background: RED, color: 'white',
              border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600,
              cursor: deleting ? 'not-allowed' : 'pointer', opacity: deleting ? 0.6 : 1,
            }}
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '8px 18px', background: '#f3f4f6', color: '#374151',
              border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export default function AdminFeedback() {
  const { isDark } = useTheme()
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([])
  const [loading, setLoading]     = useState(true)
  const [search, setSearch]       = useState('')
  const [typeFilter, setTypeFilter] = useState<FeedbackType | ''>('')
  const [detail, setDetail]       = useState<Feedback | null>(null)

  const bg    = isDark ? '#0f172a' : '#f9fafb'
  const card  = isDark ? '#1e293b' : '#ffffff'
  const text  = isDark ? '#f1f5f9' : '#111827'
  const muted = isDark ? '#64748b' : '#9ca3af'
  const border = isDark ? '#334155' : '#e5e7eb'

  const load = useCallback(async () => {
    try {
      const data = await listAllFeedback()
      setFeedbacks(data)
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const handleDelete = (id: number) => {
    setFeedbacks(prev => prev.filter(f => f.id !== id))
  }

  const filtered = useMemo(() => {
    let list = feedbacks
    if (typeFilter) list = list.filter(f => f.type === typeFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(f =>
        f.subject.toLowerCase().includes(q) ||
        f.body.toLowerCase().includes(q) ||
        (f.teacher?.name ?? '').toLowerCase().includes(q)
      )
    }
    return list
  }, [feedbacks, typeFilter, search])

  // Stats
  const typeCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const t of ALL_TYPES) m[t] = 0
    for (const f of feedbacks) m[f.type] = (m[f.type] || 0) + 1
    return m
  }, [feedbacks])

  const thStyle: CSSProperties = {
    padding: '10px 14px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.5px', color: muted, textAlign: 'left',
    borderBottom: `2px solid ${border}`, whiteSpace: 'nowrap',
  }

  const tdStyle: CSSProperties = {
    padding: '12px 14px', fontSize: 14, color: text,
    borderBottom: `1px solid ${border}`,
  }

  return (
    <div style={{ padding: '32px 40px', maxWidth: 1200, margin: '0 auto', background: bg, minHeight: '100vh' }}>
      {detail && <DetailModal fb={detail} onClose={() => setDetail(null)} onDelete={handleDelete} />}

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: text }}>
          Feedback
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: muted }}>
          Review feedback submitted by teachers across the platform.
        </p>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Total', value: feedbacks.length, color: BLUE },
          ...ALL_TYPES.map(t => ({
            label: TYPE_META[t].label.split(' ')[0],
            value: typeCounts[t],
            color: TYPE_META[t].color,
          })),
        ].map(s => (
          <div key={s.label} style={{
            background: card, borderRadius: 10, padding: '14px 16px',
            border: `1px solid ${border}`,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
              {s.label}
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex', gap: 12, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <input
          type="text"
          placeholder="Search feedback..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            padding: '9px 14px', border: `1px solid ${border}`, borderRadius: 8,
            fontSize: 14, background: card, color: text, outline: 'none', width: 260,
          }}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => setTypeFilter('')}
            style={{
              padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              cursor: 'pointer', border: typeFilter === '' ? `2px solid ${BLUE}` : `2px solid ${border}`,
              background: typeFilter === '' ? `${BLUE}15` : card, color: typeFilter === '' ? BLUE : muted,
            }}
          >
            All
          </button>
          {ALL_TYPES.map(t => {
            const meta = TYPE_META[t]
            const active = typeFilter === t
            return (
              <button
                key={t}
                onClick={() => setTypeFilter(active ? '' : t)}
                style={{
                  padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                  cursor: 'pointer', border: active ? `2px solid ${meta.color}` : `2px solid ${border}`,
                  background: active ? `${meta.color}15` : card, color: active ? meta.color : muted,
                }}
              >
                {meta.label} ({typeCounts[t]})
              </button>
            )
          })}
        </div>
      </div>

      {/* Table */}
      <div style={{ background: card, borderRadius: 12, border: `1px solid ${border}`, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: muted }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: muted }}>
            {feedbacks.length === 0 ? 'No feedback yet.' : 'No feedback matches your filters.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Subject</th>
                  <th style={thStyle}>Teacher</th>
                  <th style={thStyle}>Date</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(fb => {
                  const meta = TYPE_META[fb.type] ?? TYPE_META.other
                  return (
                    <tr
                      key={fb.id}
                      style={{ cursor: 'pointer', transition: 'background 0.1s' }}
                      onClick={() => setDetail(fb)}
                      onMouseEnter={e => (e.currentTarget.style.background = isDark ? '#1a2332' : '#f9fafb')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td style={tdStyle}>
                        <span style={{
                          padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                          background: `${meta.color}15`, color: meta.color,
                          border: `1px solid ${meta.color}40`,
                          whiteSpace: 'nowrap',
                        }}>
                          {meta.label}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                        {fb.subject}
                      </td>
                      <td style={{ ...tdStyle, color: muted, fontSize: 13 }}>
                        {fb.teacher?.name ?? 'Unknown'}
                      </td>
                      <td style={{ ...tdStyle, color: muted, fontSize: 13, whiteSpace: 'nowrap' }}>
                        {new Date(fb.created_at).toLocaleDateString()}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <button
                          onClick={e => {
                            e.stopPropagation()
                            if (!window.confirm('Delete this feedback?')) return
                            deleteFeedback(fb.id).then(() => handleDelete(fb.id)).catch(() => {})
                          }}
                          style={{
                            padding: '4px 12px', background: `${RED}15`, color: RED,
                            border: `1px solid ${RED}40`, borderRadius: 6,
                            fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
