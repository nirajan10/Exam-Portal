import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
} from 'recharts'
import { Link } from 'react-router-dom'
import { getSubmission, getExamAnalytics, type ExamAnalytics, type QuestionStat, type Exam, type Question, type Submission, type SubmissionAnswer } from '../api/client'
import { generateStudentPDF, downloadBlob, safeName } from '../utils/generateStudentPDF'
import { useTheme } from '../contexts/ThemeContext'

// ── Colour palette ─────────────────────────────────────────────────────────────

const C = {
  blue:   '#1a73e8',
  green:  '#22c55e',
  amber:  '#f59e0b',
  red:    '#ef4444',
  purple: '#8b5cf6',
  cyan:   '#06b6d4',
  slate:  '#64748b',
  gray:   '#9ca3af',
}

const DIST_COLORS = [C.red, C.amber, C.green]
const RADAR_COLOR = C.blue

// ── Pure helpers ───────────────────────────────────────────────────────────────

function computeMaxScore(exam: Exam): number {
  const sets = exam.question_sets ?? []
  if (sets.length === 0) return 0
  const sorted = [...sets].sort((a, b) => a.order - b.order)
  return (sorted[0].questions ?? []).reduce((sum, q) => sum + q.points, 0)
}

function computeAllQuestionsFlat(exam: Exam): Question[] {
  return (exam.question_sets ?? []).flatMap(qs => qs.questions ?? [])
}

function buildQMap(exam: Exam): Record<number, Question> {
  const map: Record<number, Question> = {}
  for (const qs of exam.question_sets ?? []) {
    for (const q of qs.questions ?? []) map[q.id] = q
  }
  return map
}

function scorePct(sub: Submission, maxScore: number): number {
  if (maxScore === 0) return 0
  return Math.round((sub.total_score / maxScore) * 100)
}

/** Returns minutes a student took to submit, or null if no started_at. */
function completionMins(sub: Submission, exam: Exam): number | null {
  if (!exam.started_at) return null
  const t0 = new Date(exam.started_at).getTime() + (exam.buffer_duration_minutes ?? 0) * 60_000
  const t1 = new Date(sub.submitted_at).getTime()
  const mins = (t1 - t0) / 60_000
  return mins > 0 ? Math.round(mins) : null
}

function formatMins(mins: number): string {
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function isAutoGraded(q: Question): boolean {
  return q.type === 'MCQ' || q.type === 'MRQ'
}

/** Classify a single answer for the breakdown pie. */
function classifyAnswer(a: SubmissionAnswer, q: Question | undefined): 'correct' | 'incorrect' | 'manual' | 'blank' {
  const raw = a.answer ?? ''
  const blank = raw === '' || raw === '[]'
  if (blank) return 'blank'
  if (!q) return 'manual'
  if (isAutoGraded(q)) return (a.score != null && a.score > 0) ? 'correct' : 'incorrect'
  return 'manual'
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: {
  label: string; value: string | number; sub?: string; accent?: string
}) {
  const { isDark } = useTheme()
  return (
    <div style={{
      background: isDark ? '#1e293b' : 'white',
      border: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
      borderRadius: 10, padding: '18px 22px',
      borderLeft: accent ? `4px solid ${accent}` : undefined,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: isDark ? '#94a3b8' : '#6b7280',
        textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: accent ?? (isDark ? '#f1f5f9' : '#111827'),
        lineHeight: 1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: isDark ? '#64748b' : '#9ca3af', marginTop: 4 }}>{sub}</div>
      )}
    </div>
  )
}

function SectionHeading({ children }: { children: ReactNode }) {
  const { isDark } = useTheme()
  return (
    <h3 style={{
      margin: '0 0 16px', fontSize: 15, fontWeight: 700,
      color: isDark ? '#e2e8f0' : '#111827',
      paddingBottom: 8, borderBottom: `2px solid ${isDark ? '#334155' : '#e5e7eb'}`,
    }}>
      {children}
    </h3>
  )
}

// ── Score Distribution BarChart ────────────────────────────────────────────────

function ScoreDistChart({ buckets, isDark }: {
  buckets: [number, number, number]; isDark: boolean
}) {
  const data = useMemo(() => [
    { name: '0–40%',   count: buckets[0], fill: DIST_COLORS[0] },
    { name: '41–70%',  count: buckets[1], fill: DIST_COLORS[1] },
    { name: '71–100%', count: buckets[2], fill: DIST_COLORS[2] },
  ], [buckets])

  const axisColor = isDark ? '#94a3b8' : '#6b7280'
  const gridColor = isDark ? '#334155' : '#e5e7eb'

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
        <XAxis dataKey="name" tick={{ fill: axisColor, fontSize: 13 }} />
        <YAxis allowDecimals={false} tick={{ fill: axisColor, fontSize: 12 }} width={28} />
        <Tooltip
          contentStyle={{
            background: isDark ? '#1e293b' : 'white',
            border: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
            borderRadius: 8, color: isDark ? '#f1f5f9' : '#111827',
          }}
          formatter={(v: number) => [v, 'Students']}
        />
        <Bar dataKey="count" radius={[5, 5, 0, 0]}>
          {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Question Performance BarChart (horizontal) ─────────────────────────────────

function QuestionPerfChart({ questionStats, isDark }: {
  questionStats: QuestionStat[]
  isDark: boolean
}) {
  const data = useMemo(() => {
    const autoGraded = questionStats.filter(qs => qs.question_type === 'MCQ' || qs.question_type === 'MRQ')
    return autoGraded.map((qs, idx) => {
      const pct = qs.total_attempts > 0 ? Math.round((qs.correct_count / qs.total_attempts) * 100) : 0
      return {
        name: `Q${idx + 1}`,
        label: truncate(qs.question_content, 60),
        pct,
        fill: pct >= 70 ? C.green : pct >= 40 ? C.amber : C.red,
      }
    })
  }, [questionStats])

  const axisColor = isDark ? '#94a3b8' : '#6b7280'
  const gridColor = isDark ? '#334155' : '#e5e7eb'

  if (data.length === 0) return (
    <div style={{ padding: '32px 0', textAlign: 'center', color: isDark ? '#64748b' : '#9ca3af', fontSize: 14 }}>
      No auto-graded questions to display.
    </div>
  )

  const chartH = Math.max(200, data.length * 38 + 40)

  return (
    <ResponsiveContainer width="100%" height={chartH}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 36 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} horizontal={false} />
        <XAxis type="number" domain={[0, 100]} tickFormatter={v => `${v}%`}
          tick={{ fill: axisColor, fontSize: 12 }} />
        <YAxis type="category" dataKey="name" tick={{ fill: axisColor, fontSize: 12 }} width={32} />
        <Tooltip
          contentStyle={{
            background: isDark ? '#1e293b' : 'white',
            border: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
            borderRadius: 8, color: isDark ? '#f1f5f9' : '#111827',
            maxWidth: 300,
          }}
          formatter={(v: number, _: unknown, props: { payload?: { label?: string } }) => [
            `${v}% correct`,
            props?.payload?.label ?? '',
          ]}
        />
        <Bar dataKey="pct" radius={[0, 5, 5, 0]}>
          {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Student Detail Modal ───────────────────────────────────────────────────────

function StudentModal({ exam, submission, examId, onClose, isDark }: {
  exam: Exam
  submission: Submission
  examId: string
  onClose: () => void
  isDark: boolean
}) {
  const qMap = useMemo(() => buildQMap(exam), [exam])
  const maxScore = useMemo(() => computeMaxScore(exam), [exam])
  const answers = submission.answers ?? []

  // ── Answer breakdown pie ────────────────────────────────────────────────────
  const pieData = useMemo(() => {
    let correct = 0, incorrect = 0, manual = 0, blank = 0
    for (const a of answers) {
      const cat = classifyAnswer(a, qMap[a.question_id])
      if (cat === 'correct')   correct++
      else if (cat === 'incorrect') incorrect++
      else if (cat === 'manual') manual++
      else blank++
    }
    return [
      { name: 'Correct',     value: correct,   color: C.green  },
      { name: 'Incorrect',   value: incorrect, color: C.red    },
      { name: 'Theory/Code', value: manual,    color: C.purple },
      { name: 'Not Answered',value: blank,     color: C.gray   },
    ].filter(d => d.value > 0)
  }, [answers, qMap])

  // ── Type performance radar ──────────────────────────────────────────────────
  const radarData = useMemo(() => {
    const types: Question['type'][] = ['MCQ', 'MRQ', 'code', 'theory']
    const labels: Record<Question['type'], string> = { MCQ: 'MCQ', MRQ: 'MRQ', code: 'Code', theory: 'Theory' }
    return types.map(type => {
      const qs = computeAllQuestionsFlat(exam).filter(q => q.type === type)
      if (qs.length === 0) return null
      const maxPts = qs.reduce((s, q) => s + q.points, 0)
      const earned = answers.reduce((s, a) => {
        const q = qMap[a.question_id]
        if (!q || q.type !== type) return s
        return s + (a.score ?? 0)
      }, 0)
      return { type: labels[type], score: maxPts > 0 ? Math.round((earned / maxPts) * 100) : 0, fullMark: 100 }
    }).filter(Boolean) as { type: string; score: number; fullMark: number }[]
  }, [exam, answers, qMap])

  // ── Submission timeline ─────────────────────────────────────────────────────
  const timeline = useMemo(() => {
    if (!exam.started_at) return null
    const t0 = new Date(exam.started_at).getTime() + (exam.buffer_duration_minutes ?? 0) * 60_000
    const t1 = new Date(submission.submitted_at).getTime()
    const total = exam.duration_minutes * 60_000
    const elapsed = t1 - t0
    const pct = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)))
    return { pct, mins: Math.round(elapsed / 60_000), total: exam.duration_minutes }
  }, [exam, submission])

  const bg       = isDark ? '#0f172a'  : '#f8fafc'
  const cardBg   = isDark ? '#1e293b'  : 'white'
  const border   = isDark ? '#334155'  : '#e5e7eb'
  const textMain = isDark ? '#f1f5f9'  : '#111827'
  const textMut  = isDark ? '#94a3b8'  : '#6b7280'
  const axisTick = isDark ? '#94a3b8'  : '#6b7280'
  const gridLine = isDark ? '#334155'  : '#e5e7eb'

  const pct = maxScore > 0 ? Math.round((submission.total_score / maxScore) * 100) : 0
  const pctColor = pct >= 70 ? C.green : pct >= 41 ? C.amber : C.red

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end',
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Side drawer */}
      <div style={{
        width: '100%', maxWidth: 720,
        height: '100vh', overflowY: 'auto',
        background: bg, borderLeft: `1px solid ${border}`,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Drawer header */}
        <div style={{
          padding: '20px 28px',
          background: isDark ? '#1e293b' : 'white',
          borderBottom: `1px solid ${border}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          position: 'sticky', top: 0, zIndex: 10,
        }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: textMain, marginBottom: 2 }}>
              {submission.student_name}
            </div>
            <div style={{ fontSize: 13, color: textMut }}>
              {submission.student_email}
              {submission.session_id && (
                <span style={{ marginLeft: 10, fontFamily: 'monospace', fontSize: 11,
                  background: isDark ? '#0f172a' : '#f3f4f6',
                  padding: '1px 6px', borderRadius: 4, color: isDark ? '#93c5fd' : '#374151' }}>
                  {submission.session_id}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 26, fontWeight: 900, color: pctColor, lineHeight: 1 }}>
                {submission.total_score}<span style={{ fontSize: 14, fontWeight: 500, color: textMut }}> / {maxScore}</span>
              </div>
              <div style={{ fontSize: 12, color: pctColor, fontWeight: 700 }}>{pct}%</div>
            </div>
            <button
              onClick={onClose}
              style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 6,
                padding: '6px 10px', cursor: 'pointer', color: textMut, fontSize: 18, lineHeight: 1 }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Drawer body */}
        <div style={{ padding: '24px 28px', flex: 1 }}>

          {/* Submission time row */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 28, flexWrap: 'wrap' }}>
            <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 8,
              padding: '10px 16px', flex: 1, minWidth: 160 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: textMut,
                textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 4 }}>
                Submitted
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: textMain }}>
                {new Date(submission.submitted_at).toLocaleString()}
              </div>
            </div>
            {timeline && (
              <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 8,
                padding: '10px 16px', flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: textMut,
                  textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 4 }}>
                  Completion Time
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: textMain }}>
                  {timeline.mins > 0 ? formatMins(timeline.mins) : '< 1m'}{' '}
                  <span style={{ fontSize: 12, color: textMut }}>of {timeline.total}m</span>
                </div>
                {/* Progress bar */}
                <div style={{ marginTop: 6, height: 6, borderRadius: 3,
                  background: isDark ? '#334155' : '#e5e7eb', overflow: 'hidden' }}>
                  <div style={{ width: `${timeline.pct}%`, height: '100%',
                    background: timeline.pct > 90 ? C.red : timeline.pct > 60 ? C.amber : C.green,
                    borderRadius: 3, transition: 'width 0.4s' }} />
                </div>
              </div>
            )}
            {submission.set_name && (
              <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 8,
                padding: '10px 16px', flex: 1, minWidth: 140 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: textMut,
                  textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 4 }}>
                  Question Set
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.purple }}>{submission.set_name}</div>
              </div>
            )}
          </div>

          {/* Charts row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 28 }}>

            {/* Answer Breakdown Pie */}
            <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: '18px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: textMain, marginBottom: 12 }}>
                Answer Breakdown
              </div>
              {pieData.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%" cy="50%"
                      outerRadius={72}
                      innerRadius={36}
                    >
                      {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Legend
                      iconType="circle" iconSize={10}
                      formatter={(v: string) => (
                        <span style={{ fontSize: 12, color: textMut }}>{v}</span>
                      )}
                    />
                    <Tooltip
                      contentStyle={{
                        background: isDark ? '#1e293b' : 'white',
                        border: `1px solid ${border}`, borderRadius: 8, fontSize: 13,
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: textMut, fontSize: 13 }}>
                  No answer data
                </div>
              )}
            </div>

            {/* Type Performance Radar */}
            <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: '18px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: textMain, marginBottom: 12 }}>
                Performance by Type
              </div>
              {radarData.length >= 3 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <RadarChart data={radarData} cx="50%" cy="50%" outerRadius={72}>
                    <PolarGrid stroke={gridLine} />
                    <PolarAngleAxis dataKey="type" tick={{ fill: axisTick, fontSize: 12 }} />
                    <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fill: axisTick, fontSize: 10 }}
                      tickFormatter={v => `${v}%`} />
                    <Radar name="Score %" dataKey="score"
                      stroke={RADAR_COLOR} fill={RADAR_COLOR} fillOpacity={0.25}
                      dot={{ fill: RADAR_COLOR, r: 4 }} />
                    <Tooltip
                      contentStyle={{
                        background: isDark ? '#1e293b' : 'white',
                        border: `1px solid ${border}`, borderRadius: 8, fontSize: 13,
                      }}
                      formatter={(v: number) => [`${v}%`, 'Score']}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              ) : radarData.length > 0 ? (
                // Fallback: horizontal bars if fewer than 3 types
                <div style={{ paddingTop: 12 }}>
                  {radarData.map(d => (
                    <div key={d.type} style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between',
                        fontSize: 12, color: textMut, marginBottom: 4 }}>
                        <span>{d.type}</span><span>{d.score}%</span>
                      </div>
                      <div style={{ height: 8, borderRadius: 4,
                        background: isDark ? '#334155' : '#e5e7eb', overflow: 'hidden' }}>
                        <div style={{ width: `${d.score}%`, height: '100%',
                          background: d.score >= 70 ? C.green : d.score >= 40 ? C.amber : C.red,
                          borderRadius: 4 }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: textMut, fontSize: 13 }}>
                  No scored answers yet
                </div>
              )}
            </div>
          </div>

          {/* Per-question answer list */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: textMain, marginBottom: 10 }}>
              Question Scores
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {answers.map((a, idx) => {
                const q = qMap[a.question_id]
                const blank = (a.answer ?? '') === '' || (a.answer ?? '') === '[]'
                const cat = classifyAnswer(a, q)
                const dotColor = cat === 'correct' ? C.green
                  : cat === 'incorrect' ? C.red
                  : cat === 'manual' ? C.purple
                  : C.gray
                return (
                  <div key={a.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: isDark ? '#0f172a' : '#f9fafb',
                    border: `1px solid ${border}`, borderRadius: 7,
                    padding: '8px 12px', fontSize: 13,
                  }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%',
                      background: dotColor, flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, color: textMut, minWidth: 24, flexShrink: 0 }}>
                      Q{idx + 1}
                    </span>
                    <span style={{ flex: 1, color: isDark ? '#cbd5e1' : '#374151',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {q ? truncate(q.content, 80) : `Question #${a.question_id}`}
                    </span>
                    <span style={{ fontWeight: 700, color: dotColor, flexShrink: 0 }}>
                      {blank ? '—' : a.score != null ? `${a.score}/${q?.points ?? '?'}` : 'Ungraded'}
                    </span>
                  </div>
                )
              })}
              {answers.length === 0 && (
                <div style={{ color: textMut, fontSize: 13 }}>No answers recorded.</div>
              )}
            </div>
          </div>

          {/* Link to full grading */}
          <Link to={`/exams/${examId}/grade/${submission.id}`} style={{ textDecoration: 'none' }}>
            <button style={{
              padding: '10px 24px', background: C.blue, color: 'white',
              border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 700,
              cursor: 'pointer', width: '100%',
            }}>
              {submission.status === 'pending_grading' ? 'Grade This Submission →' : 'Review Full Submission →'}
            </button>
          </Link>
        </div>
      </div>
    </div>
  )
}

// ── Sort indicator ─────────────────────────────────────────────────────────────

function SortIndicator({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <span style={{ opacity: 0.3, marginLeft: 4 }}>⇅</span>
  return <span style={{ marginLeft: 4 }}>{dir === 'asc' ? '↑' : '↓'}</span>
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  exam: Exam
  submissions: Submission[]
  examId: string
}

type SortKey = 'name' | 'score' | 'submitted' | 'status' | 'set'

export default function ResultsAnalytics({ exam, submissions, examId }: Props) {
  const { isDark } = useTheme()

  // API-aggregated analytics (score buckets, question stats)
  const [analytics, setAnalytics]           = useState<ExamAnalytics | null>(null)

  // Detailed submission data (answers included) — fetched on demand
  const [allDetails, setAllDetails]         = useState<Record<number, Submission>>({})
  const [loadingDetail, setLoadingDetail]   = useState(false)
  const [detailLoaded, setDetailLoaded]     = useState(false)

  // Student modal
  const [selectedId, setSelectedId]         = useState<number | null>(null)
  const [loadingModal, setLoadingModal]     = useState(false)

  // Table sorting
  const [sortKey, setSortKey]   = useState<SortKey>('submitted')
  const [sortDir, setSortDir]   = useState<'asc' | 'desc'>('asc')

  // PDF download
  const [downloading, setDownloading]       = useState<number | null>(null)
  const [downloadingBulk, setDownloadingBulk] = useState(false)
  const [selected, setSelected]             = useState<Set<number>>(new Set())

  // Fetch analytics on mount
  useEffect(() => {
    if (!examId) return
    getExamAnalytics(examId).then(setAnalytics).catch(() => {/* silent */})
  }, [examId])

  // ── Derived metrics ──────────────────────────────────────────────────────────

  const maxScore = useMemo(() => computeMaxScore(exam), [exam])

  const avgScore = useMemo(() => {
    if (submissions.length === 0) return 0
    const total = submissions.reduce((s, sub) => s + sub.total_score, 0)
    return Math.round(total / submissions.length)
  }, [submissions])

  const avgPct = maxScore > 0 ? Math.round((avgScore / maxScore) * 100) : 0

  const passRate = useMemo(() => {
    if (submissions.length === 0) return 0
    const passing = submissions.filter(s => scorePct(s, maxScore) > 40).length
    return Math.round((passing / submissions.length) * 100)
  }, [submissions, maxScore])

  const avgCompletionMin = useMemo(() => {
    const times = submissions.map(s => completionMins(s, exam)).filter((m): m is number => m !== null)
    if (times.length === 0) return null
    return Math.round(times.reduce((a, b) => a + b, 0) / times.length)
  }, [submissions, exam])

  const highestScore = useMemo(() =>
    submissions.length > 0 ? Math.max(...submissions.map(s => s.total_score)) : 0,
  [submissions])

  // ── Sorted table ─────────────────────────────────────────────────────────────

  const sortedSubs = useMemo(() => {
    const arr = [...submissions]
    arr.sort((a, b) => {
      let av: string | number, bv: string | number
      switch (sortKey) {
        case 'name':      av = a.student_name.toLowerCase();      bv = b.student_name.toLowerCase();      break
        case 'score':     av = a.total_score;                     bv = b.total_score;                     break
        case 'submitted': av = new Date(a.submitted_at).getTime(); bv = new Date(b.submitted_at).getTime(); break
        case 'status':    av = a.status;                          bv = b.status;                          break
        case 'set':       av = a.set_name;                        bv = b.set_name;                        break
        default:          av = 0; bv = 0
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return arr
  }, [submissions, sortKey, sortDir])

  // ── Actions ──────────────────────────────────────────────────────────────────

  const toggleSort = useCallback((key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }, [sortKey])

  const loadAllDetails = useCallback(async () => {
    if (detailLoaded || loadingDetail || submissions.length === 0) return
    setLoadingDetail(true)
    try {
      const results = await Promise.all(submissions.map(s => getSubmission(s.id)))
      const map: Record<number, Submission> = {}
      for (const s of results) map[s.id] = s
      setAllDetails(map)
      setDetailLoaded(true)
    } catch { /* silent */ }
    finally { setLoadingDetail(false) }
  }, [submissions, detailLoaded, loadingDetail])

  const openStudentModal = useCallback(async (id: number) => {
    if (allDetails[id]) { setSelectedId(id); return }
    setLoadingModal(true)
    try {
      const s = await getSubmission(id)
      setAllDetails(prev => ({ ...prev, [id]: s }))
      setSelectedId(id)
    } catch { /* silent */ }
    finally { setLoadingModal(false) }
  }, [allDetails])

  const handleDownloadPDF = useCallback(async (s: Submission) => {
    setDownloading(s.id)
    try {
      let detailed = allDetails[s.id]
      if (!detailed) {
        const fetched = await getSubmission(s.id)
        setAllDetails(prev => ({ ...prev, [s.id]: fetched }))
        detailed = fetched
      }
      const blob = await generateStudentPDF(exam, detailed)
      const code = exam.login_code || String(exam.id)
      downloadBlob(blob, `Report_${safeName(s.student_name)}_${safeName(code)}.pdf`)
    } catch { /* silent */ }
    finally { setDownloading(null) }
  }, [allDetails, exam])

  const handleDownloadSelected = useCallback(async () => {
    if (selected.size === 0 || downloadingBulk) return
    setDownloadingBulk(true)
    try {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      const targets = sortedSubs.filter(s => selected.has(s.id))
      for (const s of targets) {
        let detailed = allDetails[s.id]
        if (!detailed) {
          const fetched = await getSubmission(s.id)
          setAllDetails(prev => ({ ...prev, [s.id]: fetched }))
          detailed = fetched
        }
        const blob = await generateStudentPDF(exam, detailed)
        const code = exam.login_code || String(exam.id)
        zip.file(`Report_${safeName(s.student_name)}_${safeName(code)}.pdf`, blob)
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(zipBlob, `Reports_${safeName(exam.title)}.zip`)
    } catch { /* silent */ }
    finally { setDownloadingBulk(false) }
  }, [selected, sortedSubs, allDetails, exam, downloadingBulk])

  const toggleSelect = useCallback((id: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  // ── Computed per-submission type score columns (when detailed data is loaded) ──

  const typeScores = useMemo(() => {
    if (!detailLoaded) return null
    const qMap = buildQMap(exam)
    const result: Record<number, { mcq: number; code: number; theory: number }> = {}
    for (const [idStr, sub] of Object.entries(allDetails)) {
      const id = Number(idStr)
      let mcq = 0, code = 0, theory = 0
      for (const a of sub.answers ?? []) {
        const q = qMap[a.question_id]
        if (!q) continue
        const s = a.score ?? 0
        if (q.type === 'MCQ' || q.type === 'MRQ') mcq += s
        else if (q.type === 'code') code += s
        else if (q.type === 'theory') theory += s
      }
      result[id] = { mcq, code, theory }
    }
    return result
  }, [detailLoaded, allDetails, exam])

  // ── Style tokens ─────────────────────────────────────────────────────────────

  const cardBg   = isDark ? '#1e293b'  : 'white'
  const border   = isDark ? '#334155'  : '#e5e7eb'
  const textMain = isDark ? '#f1f5f9'  : '#111827'
  const textMut  = isDark ? '#94a3b8'  : '#6b7280'
  const rowHover = isDark ? '#1e293b'  : '#f9fafb'
  const thBg     = isDark ? '#0f172a'  : '#f9fafb'

  const th: CSSProperties = {
    padding: '10px 12px', textAlign: 'left',
    color: textMut, fontSize: 12, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.4px',
    cursor: 'pointer', userSelect: 'none',
    whiteSpace: 'nowrap',
  }

  const td: CSSProperties = { padding: '10px 12px', fontSize: 14, color: textMain }

  if (submissions.length === 0) return (
    <div style={{ textAlign: 'center', padding: '56px 24px', color: textMut }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>No submissions yet.</div>
      <div style={{ fontSize: 13, marginTop: 4 }}>Analytics will appear once students start submitting.</div>
    </div>
  )

  const selectedSub = selectedId != null ? (allDetails[selectedId] ?? null) : null

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <style>{`
        @media print {
          nav, .analytics-no-print { display: none !important; }
          body { background: white !important; }
          * { box-shadow: none !important; }
        }
      `}</style>

      {/* ── Student detail modal ─────────────────────────────────────────── */}
      {selectedSub && (
        <StudentModal
          exam={exam}
          submission={selectedSub}
          examId={examId}
          onClose={() => setSelectedId(null)}
          isDark={isDark}
        />
      )}

      {/* ── Stat cards ───────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: 14, marginBottom: 32 }}>
        <StatCard label="Total Submissions"  value={submissions.length}                    accent={C.blue}   />
        <StatCard label="Average Score"      value={`${avgScore} pts`}  sub={`${avgPct}%`} accent={C.cyan}   />
        <StatCard label="Pass Rate (> 40%)"  value={`${passRate}%`}                        accent={C.green}  />
        <StatCard label="Highest Score"      value={`${highestScore} pts`}                 accent={C.purple} />
        {avgCompletionMin != null && (
          <StatCard label="Avg Completion"   value={formatMins(avgCompletionMin)}           accent={C.amber}  />
        )}
      </div>

      {/* ── Class-wide charts ────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 32 }}>

        {/* Score Distribution */}
        <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 12, padding: '20px 24px' }}>
          <SectionHeading>Score Distribution</SectionHeading>
          <div style={{ fontSize: 12, color: textMut, marginBottom: 12 }}>
            Students by score bracket (out of {maxScore} pts)
          </div>
          {analytics ? (
            <ScoreDistChart buckets={analytics.score_buckets} isDark={isDark} />
          ) : (
            <ScoreDistChart
              buckets={[
                submissions.filter(s => scorePct(s, maxScore) <= 40).length,
                submissions.filter(s => { const p = scorePct(s, maxScore); return p > 40 && p <= 70 }).length,
                submissions.filter(s => scorePct(s, maxScore) > 70).length,
              ]}
              isDark={isDark}
            />
          )}
        </div>

        {/* Question Performance — uses API data */}
        <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 12, padding: '20px 24px' }}>
          <SectionHeading>Question Performance (Auto-Graded)</SectionHeading>
          {analytics ? (
            <QuestionPerfChart questionStats={analytics.question_stats} isDark={isDark} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: 180, color: textMut, fontSize: 13 }}>
              Loading analytics…
            </div>
          )}
        </div>
      </div>

      {/* ── Submissions table ─────────────────────────────────────────────── */}
      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 12,
        overflow: 'hidden', marginBottom: 24 }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${border}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: textMain }}>
            All Submissions
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} className="analytics-no-print">
            {selected.size > 0 && (
              <button
                onClick={handleDownloadSelected}
                disabled={downloadingBulk}
                style={{
                  padding: '6px 14px', fontSize: 12, fontWeight: 700,
                  background: downloadingBulk ? '#93c5fd' : C.blue,
                  color: 'white', border: 'none', borderRadius: 6,
                  cursor: downloadingBulk ? 'not-allowed' : 'pointer',
                }}
              >
                {downloadingBulk ? '⏳ Zipping…' : `⬇ ZIP (${selected.size})`}
              </button>
            )}
            {!detailLoaded && (
              <button
                onClick={loadAllDetails}
                disabled={loadingDetail}
                style={{
                  padding: '6px 14px', fontSize: 12, fontWeight: 700,
                  background: loadingDetail ? '#93c5fd' : C.blue,
                  color: 'white', border: 'none', borderRadius: 6,
                  cursor: loadingDetail ? 'not-allowed' : 'pointer',
                }}
              >
                {loadingDetail ? '⏳ Loading…' : 'Load MCQ/Code Scores'}
              </button>
            )}
            {detailLoaded && (
              <span style={{ fontSize: 12, color: C.green, fontWeight: 600 }}>✓ Detailed data loaded</span>
            )}
            {loadingModal && (
              <span style={{ fontSize: 12, color: textMut }}>Loading…</span>
            )}
            <button
              onClick={() => window.print()}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 700,
                background: isDark ? '#1e293b' : '#f3f4f6',
                color: textMut, border: `1px solid ${border}`,
                borderRadius: 6, cursor: 'pointer',
              }}
            >
              🖨 Print
            </button>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: thBg }}>
                <th style={{ ...th, cursor: 'default', padding: '10px 8px', width: 32 }}>
                  <input
                    type="checkbox"
                    checked={selected.size > 0 && selected.size === submissions.length}
                    onChange={e => setSelected(e.target.checked ? new Set(submissions.map(s => s.id)) : new Set())}
                    style={{ cursor: 'pointer' }}
                  />
                </th>
                <th style={th} onClick={() => toggleSort('name')}>
                  Name <SortIndicator active={sortKey === 'name'} dir={sortDir} />
                </th>
                <th style={{ ...th, cursor: 'default' }}>Session</th>
                <th style={th} onClick={() => toggleSort('set')}>
                  Set <SortIndicator active={sortKey === 'set'} dir={sortDir} />
                </th>
                <th style={th} onClick={() => toggleSort('score')}>
                  Total <SortIndicator active={sortKey === 'score'} dir={sortDir} />
                </th>
                {typeScores && <th style={{ ...th, cursor: 'default' }}>MCQ</th>}
                {typeScores && <th style={{ ...th, cursor: 'default' }}>Code</th>}
                <th style={th} onClick={() => toggleSort('status')}>
                  Status <SortIndicator active={sortKey === 'status'} dir={sortDir} />
                </th>
                <th style={th} onClick={() => toggleSort('submitted')}>
                  Submitted <SortIndicator active={sortKey === 'submitted'} dir={sortDir} />
                </th>
                <th style={{ ...th, cursor: 'default' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedSubs.map(s => {
                const pct = scorePct(s, maxScore)
                const pctColor = pct >= 70 ? C.green : pct >= 41 ? C.amber : C.red
                const ts = typeScores?.[s.id]
                return (
                  <tr key={s.id} style={{ borderTop: `1px solid ${border}` }}
                    onMouseEnter={e => (e.currentTarget.style.background = rowHover)}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}
                  >
                    <td style={{ ...td, padding: '10px 8px' }}>
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={() => toggleSelect(s.id)}
                        style={{ cursor: 'pointer' }}
                      />
                    </td>
                    <td style={{ ...td, fontWeight: 600 }}>{s.student_name}</td>
                    <td style={td}>
                      {s.session_id ? (
                        <span style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700,
                          padding: '2px 7px', borderRadius: 4,
                          background: isDark ? '#0f172a' : '#f3f4f6',
                          color: isDark ? '#93c5fd' : '#374151' }}>
                          {s.session_id}
                        </span>
                      ) : <span style={{ color: textMut }}>—</span>}
                    </td>
                    <td style={td}>
                      {s.set_name ? (
                        <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 8px',
                          borderRadius: 5, background: isDark ? '#1e1b4b' : '#ede9fe', color: '#6d28d9' }}>
                          {s.set_name}
                        </span>
                      ) : <span style={{ color: textMut }}>—</span>}
                    </td>
                    <td style={td}>
                      <span style={{ fontWeight: 800, color: pctColor }}>{s.total_score}</span>
                      <span style={{ color: textMut, fontSize: 12 }}> / {maxScore}</span>
                      <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700,
                        color: pctColor, background: `${pctColor}22`,
                        padding: '1px 6px', borderRadius: 9999 }}>
                        {pct}%
                      </span>
                    </td>
                    {typeScores && (
                      <td style={{ ...td, fontWeight: 600, color: C.blue }}>
                        {ts?.mcq ?? '—'}
                      </td>
                    )}
                    {typeScores && (
                      <td style={{ ...td, fontWeight: 600, color: C.purple }}>
                        {ts?.code ?? '—'}
                      </td>
                    )}
                    <td style={td}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 9999,
                        whiteSpace: 'nowrap',
                        background: s.status === 'graded' ? '#dcfce7' : '#fef3c7',
                        color: s.status === 'graded' ? '#15803d' : '#92400e',
                      }}>
                        {s.status === 'graded' ? '✓ Graded' : '⏳ Pending'}
                      </span>
                    </td>
                    <td style={{ ...td, fontSize: 12, color: textMut, whiteSpace: 'nowrap' }}>
                      {new Date(s.submitted_at).toLocaleString()}
                    </td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'nowrap' }}>
                        <button
                          onClick={() => openStudentModal(s.id)}
                          disabled={loadingModal}
                          style={{
                            padding: '4px 9px', fontSize: 12, fontWeight: 700,
                            background: isDark ? '#1e3a5f' : '#eff6ff',
                            color: C.blue, border: `1px solid ${isDark ? '#1e40af' : '#bfdbfe'}`,
                            borderRadius: 5, cursor: loadingModal ? 'not-allowed' : 'pointer',
                          }}
                        >
                          Details
                        </button>
                        <button
                          onClick={() => handleDownloadPDF(s)}
                          disabled={downloading === s.id}
                          title="Download PDF report"
                          style={{
                            padding: '4px 9px', fontSize: 12, fontWeight: 700,
                            background: isDark ? '#172554' : '#f0fdf4',
                            color: downloading === s.id ? C.slate : C.green,
                            border: `1px solid ${isDark ? '#166534' : '#bbf7d0'}`,
                            borderRadius: 5, cursor: downloading === s.id ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {downloading === s.id ? '⏳' : '⬇ PDF'}
                        </button>
                        <Link to={`/exams/${examId}/grade/${s.id}`}>
                          <button style={{
                            padding: '4px 9px', fontSize: 12, fontWeight: 600,
                            background: s.status === 'pending_grading' ? C.blue : (isDark ? '#1e293b' : '#f3f4f6'),
                            color: s.status === 'pending_grading' ? 'white' : textMut,
                            border: 'none', borderRadius: 5, cursor: 'pointer',
                          }}>
                            {s.status === 'pending_grading' ? 'Grade' : 'Review'}
                          </button>
                        </Link>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend for score colours */}
      <div style={{ display: 'flex', gap: 20, fontSize: 12, color: textMut, justifyContent: 'flex-end' }}>
        {[['0–40%', C.red], ['41–70%', C.amber], ['71–100%', C.green]].map(([l, c]) => (
          <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%',
              background: c as string, display: 'inline-block' }} />
            {l}
          </span>
        ))}
      </div>
    </div>
  )
}
