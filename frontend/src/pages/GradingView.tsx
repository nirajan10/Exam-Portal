import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  getExam, getSubmission, gradeSubmission, executeCode, autoGradeSubmission,
  Exam, Question, RunResult, Submission, SubmissionAnswer,
} from '../api/client'
import { useTheme } from '../contexts/ThemeContext'

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildQuestionMap(exam: Exam): Record<number, Question> {
  const map: Record<number, Question> = {}
  for (const qs of exam.question_sets ?? []) {
    for (const q of qs.questions ?? []) {
      map[q.id] = q
    }
  }
  return map
}

function StatusBadge({ status }: { status: Submission['status'] }) {
  const isGraded = status === 'graded'
  return (
    <span style={{
      fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 9999,
      background: isGraded ? '#dcfce7' : '#fef3c7',
      color: isGraded ? '#15803d' : '#92400e',
    }}>
      {isGraded ? 'Graded' : 'Pending Grading'}
    </span>
  )
}

function TypeBadge({ type }: { type: Question['type'] }) {
  const cfg: Record<string, { label: string; bg: string; color: string }> = {
    MCQ:    { label: 'MCQ',    bg: '#dbeafe', color: '#1d4ed8' },
    MRQ:    { label: 'MRQ',    bg: '#ede9fe', color: '#6d28d9' },
    code:   { label: 'Code',   bg: '#dcfce7', color: '#15803d' },
    theory: { label: 'Theory', bg: '#fef3c7', color: '#92400e' },
  }
  const { label, bg, color } = cfg[type] ?? { label: type, bg: '#f3f4f6', color: '#374151' }
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 9999,
      background: bg, color,
    }}>
      {label}
    </span>
  )
}

// ── Student answer renderer ───────────────────────────────────────────────────
// Returns color-coded JSX based on question type and correctness.

function renderStudentAnswer(answer: SubmissionAnswer, question: Question | undefined) {
  const text = answer.answer ?? ''
  const isNotAnswered = text === '' || text === '[]'

  if (isNotAnswered) {
    return (
      <span style={{
        fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 9999,
        display: 'inline-block', background: '#fef3c7', color: '#92400e',
      }}>
        Not Answered
      </span>
    )
  }

  if (question?.type === 'MCQ') {
    const isCorrect = question.correct_answers?.includes(text) ?? false
    return (
      <span style={{
        fontSize: 13, fontWeight: 600, padding: '4px 12px', borderRadius: 6,
        display: 'inline-block',
        background: isCorrect ? '#dcfce7' : '#fee2e2',
        color: isCorrect ? '#15803d' : '#dc2626',
        border: `1px solid ${isCorrect ? '#86efac' : '#fca5a5'}`,
      }}>
        {text}&nbsp;{isCorrect ? '✓' : '✗'}
      </span>
    )
  }

  if (question?.type === 'MRQ') {
    let selected: string[] = []
    try { selected = JSON.parse(text) } catch { selected = [] }
    const correct = question.correct_answers ?? []
    if (selected.length === 0) {
      return (
        <span style={{ fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 9999,
          display: 'inline-block', background: '#fef3c7', color: '#92400e' }}>
          Not Answered
        </span>
      )
    }
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {selected.map((opt, i) => {
          const isCorrect = correct.includes(opt)
          return (
            <span key={i} style={{
              fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 6,
              background: isCorrect ? '#dcfce7' : '#fee2e2',
              color: isCorrect ? '#15803d' : '#dc2626',
              border: `1px solid ${isCorrect ? '#86efac' : '#fca5a5'}`,
            }}>
              {opt}&nbsp;{isCorrect ? '✓' : '✗'}
            </span>
          )
        })}
      </div>
    )
  }

  if (question?.type === 'code') {
    const lang = question.language || 'code'
    const langLabel: Record<string, string> = { python: 'Python 3', c: 'C', cpp: 'C++ 17' }
    return (
      <div>
        <div style={{ marginBottom: 6 }}>
          <span style={{
            fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 4,
            background: '#0d1117', color: '#93c5fd', letterSpacing: '0.4px',
            fontFamily: 'monospace',
          }}>
            {langLabel[lang] ?? lang}
          </span>
        </div>
        <pre style={{
          margin: 0, fontFamily: "'Courier New', Courier, monospace", fontSize: 13,
          background: '#0d1117', color: '#e6edf3',
          padding: '10px 14px', borderRadius: 6,
          overflowX: 'auto', whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto',
          lineHeight: 1.6, border: '1px solid #21262d',
        }}>
          {text}
        </pre>
      </div>
    )
  }

  // theory — background set by CSS var so it adapts to dark mode
  return (
    <p style={{
      margin: 0, fontSize: 14, color: 'var(--text)', lineHeight: 1.55,
      background: 'var(--card-bg2)', padding: '10px 12px', borderRadius: 6, minHeight: 48,
      border: '1px solid var(--border)',
    }}>
      {text}
    </p>
  )
}

// ── Teacher code runner ───────────────────────────────────────────────────────
// Runs the student's code via the JWT-protected /api/execute endpoint,
// which has no run-count limit. Supports optional stdin for edge-case testing.

function CodeRunnerPanel({ code }: { code: string }) {
  const [language, setLanguage] = useState<'python' | 'c' | 'cpp'>('python')
  const [stdin, setStdin] = useState('')
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<RunResult | null>(null)
  const [runError, setRunError] = useState('')
  const consoleRef = useRef<HTMLDivElement>(null)

  const handleRun = async () => {
    setRunning(true)
    setRunError('')
    try {
      const result = await executeCode(language, code, stdin)
      setOutput(result)
      setTimeout(() => consoleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50)
    } catch {
      setRunError('Execution failed. Ensure the backend runner is available.')
    } finally {
      setRunning(false)
    }
  }

  const langLabel: Record<string, string> = { python: 'Python 3', c: 'C', cpp: 'C++ 17' }

  return (
    <div style={{ marginTop: 16, borderTop: '1px dashed var(--border)', paddingTop: 14 }}>
      {/* Panel title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.2px' }}>
          ▶ Teacher Code Runner
        </span>
        <span style={{
          fontSize: 11, padding: '1px 8px', borderRadius: 9999,
          background: '#dcfce7', color: '#15803d', fontWeight: 700,
        }}>
          Unlimited Runs · JWT
        </span>
      </div>

      {/* Language selector + stdin side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 12, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.5px', marginBottom: 5 }}>
            LANGUAGE
          </div>
          <select
            value={language}
            onChange={e => setLanguage(e.target.value as 'python' | 'c' | 'cpp')}
            style={{
              padding: '7px 10px', border: '1px solid var(--input-border)', borderRadius: 6,
              fontSize: 13, background: 'var(--input-bg)', color: 'var(--text)', cursor: 'pointer', fontWeight: 500,
            }}
          >
            <option value="python">Python 3</option>
            <option value="c">C</option>
            <option value="cpp">C++ 17</option>
          </select>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.5px', marginBottom: 5 }}>
            STANDARD INPUT (stdin) — optional
          </div>
          <textarea
            value={stdin}
            onChange={e => setStdin(e.target.value)}
            placeholder={`Feed input to the ${langLabel[language]} program (e.g. test values)…`}
            rows={2}
            style={{
              width: '100%', padding: '7px 10px', border: '1px solid var(--input-border)',
              borderRadius: 6, fontSize: 12, fontFamily: "'Courier New', monospace",
              resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.5,
              background: 'var(--input-bg)', color: 'var(--text)',
            }}
          />
        </div>
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button
          onClick={handleRun}
          disabled={running}
          style={{
            padding: '7px 20px', fontSize: 13, fontWeight: 700,
            background: running ? '#93c5fd' : '#1a73e8',
            color: 'white', border: 'none', borderRadius: 6,
            cursor: running ? 'not-allowed' : 'pointer',
          }}
        >
          {running ? '⏳ Running…' : '▶ Run Code'}
        </button>
        {output !== null && (
          <button
            onClick={() => { setOutput(null); setRunError('') }}
            style={{
              padding: '7px 14px', fontSize: 13, fontWeight: 600,
              background: 'var(--card-bg2)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
            }}
          >
            ✕ Reset Output
          </button>
        )}
      </div>

      {runError && (
        <p style={{ margin: '0 0 10px', fontSize: 13, color: '#dc2626' }}>⚠ {runError}</p>
      )}

      {/* Output console */}
      {output !== null && (
        <div ref={consoleRef} style={{
          fontFamily: "'Courier New', monospace", fontSize: 12.5,
          background: '#0f172a', borderRadius: 8, overflow: 'hidden',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        }}>
          {/* Status bar */}
          <div style={{
            display: 'flex', gap: 14, alignItems: 'center',
            padding: '7px 14px', background: '#1e293b', borderBottom: '1px solid #334155',
          }}>
            <span style={{
              fontSize: 11, fontWeight: 800,
              color: output.timed_out ? '#f59e0b'
                : output.exit_code === 0 ? '#4ade80' : '#f87171',
            }}>
              {output.timed_out ? '⏱ TIMED OUT'
                : output.exit_code === 0 ? '✓ EXIT 0'
                : `✗ EXIT ${output.exit_code}`}
            </span>
            <span style={{ fontSize: 11, color: '#64748b' }}>execution complete</span>
          </div>

          {output.stdout && (
            <div style={{ padding: '10px 14px', borderBottom: output.stderr ? '1px solid #1e293b' : 'none' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#4ade80', letterSpacing: '0.6px', marginBottom: 5 }}>
                STDOUT
              </div>
              <pre style={{ margin: 0, color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }}>
                {output.stdout}
              </pre>
            </div>
          )}

          {output.stderr && (
            <div style={{ padding: '10px 14px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#f87171', letterSpacing: '0.6px', marginBottom: 5 }}>
                STDERR
              </div>
              <pre style={{ margin: 0, color: '#fca5a5', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }}>
                {output.stderr}
              </pre>
            </div>
          )}

          {!output.stdout && !output.stderr && (
            <div style={{ padding: '14px', color: '#64748b', fontSize: 12 }}>(no output)</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Local grade state ─────────────────────────────────────────────────────────

interface LocalGrade {
  score: string
  feedback: string
}

// ── Answer card ───────────────────────────────────────────────────────────────

interface AnswerCardProps {
  answer: SubmissionAnswer
  question: Question | undefined
  grade: LocalGrade
  isDark?: boolean
  scoreError: string
  onChange: (g: LocalGrade) => void
}

function AnswerCard({ answer, question, grade, scoreError, onChange, isDark = false }: AnswerCardProps) {
  const needsManualGrading = question?.type === 'theory' || question?.type === 'code'
  const isAutoGraded = question?.type === 'MCQ' || question?.type === 'MRQ'
  const maxPoints = question?.points ?? 0
  const isNotAnswered = (answer.answer ?? '') === '' || (answer.answer ?? '') === '[]'

  const needsGrading = needsManualGrading && !isNotAnswered && answer.score == null
  const cardStyle: CSSProperties = {
    border: `1px solid ${needsGrading ? '#fde047' : (isDark ? '#1e293b' : '#e2e8f0')}`,
    borderRadius: 10, padding: 20, marginBottom: 16,
    background: isDark ? '#0f172a' : '#ffffff',
    boxShadow: isDark ? '0 1px 4px rgba(0,0,0,0.3)' : '0 1px 4px rgba(0,0,0,0.04)',
  }

  return (
    <div style={cardStyle}>
      {/* Header badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {question && <TypeBadge type={question.type} />}
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 9999,
          background: '#fef9c3', color: '#854d0e',
        }}>
          {maxPoints} mark{maxPoints !== 1 ? 's' : ''}
        </span>
        {isAutoGraded && (
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 9999,
            background: '#e0f2fe', color: '#0369a1' }}>
            Auto-graded
          </span>
        )}
        {isNotAnswered && (
          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 9999,
            background: '#fef3c7', color: '#92400e' }}>
            Not Answered
          </span>
        )}
        {needsManualGrading && !isNotAnswered && answer.score == null && (
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 9999,
            background: '#fef3c7', color: '#92400e' }}>
            Needs grading
          </span>
        )}
      </div>

      {/* Two-column layout: question | answer */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase',
            letterSpacing: '0.5px', marginBottom: 6 }}>
            Question
          </div>
          <p style={{ margin: 0, fontSize: 14, color: isDark ? '#e2e8f0' : '#1e293b', lineHeight: 1.55 }}>
            {question?.content ?? `Question #${answer.question_id}`}
          </p>
          {isAutoGraded && question?.correct_answers && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#15803d', marginBottom: 3 }}>
                Correct answer(s):
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {question.correct_answers.map((a, i) => (
                  <span key={i} style={{
                    fontSize: 12, padding: '2px 8px', borderRadius: 4,
                    background: '#dcfce7', color: '#15803d', fontWeight: 600,
                  }}>
                    {a}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase',
            letterSpacing: '0.5px', marginBottom: 6 }}>
            Student's Answer
          </div>
          {renderStudentAnswer(answer, question)}
        </div>
      </div>

      {/* Code runner — teacher can re-run with custom stdin, unlimited times */}
      {question?.type === 'code' && !isNotAnswered && (
        <CodeRunnerPanel code={answer.answer} />
      )}

      {/* Score row */}
      {isAutoGraded ? (() => {
        // Rule: score > 0 → green; score = 0 → red; not answered → grey.
        const scoreVal = answer.score ?? 0
        const isZero   = scoreVal === 0
        const bg     = isNotAnswered ? '#f9fafb'  : isZero ? '#fef2f2'  : '#f0fdf4'
        const border = isNotAnswered ? '#e5e7eb'  : isZero ? '#fca5a5'  : '#bbf7d0'
        const color  = isNotAnswered ? '#6b7280'  : isZero ? '#dc2626'  : '#15803d'
        const icon   = isNotAnswered ? '—'        : isZero ? '✗'        : '✓'
        const label  = isNotAnswered ? 'Not attempted'
                     : isZero       ? 'Incorrect / No marks'
                     : scoreVal === maxPoints ? 'Full marks' : 'Partial credit'
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
            background: bg, borderRadius: 7, border: `1px solid ${border}` }}>
            <span style={{ fontSize: 13, fontWeight: 700, color }}>
              Score: {scoreVal} / {maxPoints}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color }}>
              {icon} {label}
            </span>
          </div>
        )
      })() : (
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 5 }}>
              Award Marks <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>/ {maxPoints}</span>
            </label>
            <input
              type="number"
              min={0}
              max={maxPoints}
              value={grade.score}
              onChange={e => onChange({ ...grade, score: e.target.value })}
              style={{
                width: 88, padding: '8px 10px',
                border: `1.5px solid ${scoreError ? '#dc2626' : 'var(--input-border)'}`, borderRadius: 6,
                fontSize: 15, fontWeight: 700, textAlign: 'center', boxSizing: 'border-box',
                background: 'var(--input-bg)', color: 'var(--text)',
              }}
              placeholder="0"
            />
            {scoreError && (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#dc2626', maxWidth: 260 }}>
                ⚠ {scoreError}
              </p>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 5 }}>
              Feedback <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              value={grade.feedback}
              onChange={e => onChange({ ...grade, feedback: e.target.value })}
              rows={2}
              placeholder="e.g. Good explanation, but missed edge cases."
              style={{
                width: '100%', padding: '8px 10px',
                border: '1px solid var(--input-border)', borderRadius: 6,
                fontSize: 13, fontFamily: 'inherit', resize: 'vertical',
                boxSizing: 'border-box', lineHeight: 1.5,
                background: 'var(--input-bg)', color: 'var(--text)',
              }}
            />
          </div>
        </div>
      )}

      {/* Previously-saved score chip for theory/code — colored red if 0, green if >0 */}
      {needsManualGrading && answer.score != null && (() => {
        const saved  = answer.score
        const isZero = saved === 0
        return (
          <div style={{
            marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: 7,
            background: isZero ? '#fef2f2' : '#f0fdf4',
            border: `1px solid ${isZero ? '#fca5a5' : '#bbf7d0'}`,
          }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: isZero ? '#dc2626' : '#15803d' }}>
              {isZero ? '✗' : '✓'} Awarded: {saved} / {maxPoints}
            </span>
            {isZero && (
              <span style={{ fontSize: 11, color: '#b91c1c' }}>— No marks awarded</span>
            )}
          </div>
        )
      })()}

      {isAutoGraded && answer.feedback && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: '#6b7280' }}>
          Feedback: {answer.feedback}
        </p>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function GradingView() {
  const { examId, submissionId } = useParams<{ examId: string; submissionId: string }>()
  const { isDark } = useTheme()
  const text   = isDark ? '#f1f5f9' : '#0f172a'
  const muted  = isDark ? '#94a3b8' : '#64748b'
  const border = isDark ? '#334155' : '#e2e8f0'

  const [exam,       setExam]       = useState<Exam | null>(null)
  const [submission, setSubmission] = useState<Submission | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [saving,     setSaving]     = useState(false)
  const [saved,      setSaved]      = useState(false)
  const [error,      setError]      = useState('')

  const [grades,      setGrades]      = useState<Record<number, LocalGrade>>({})
  const [scoreErrors, setScoreErrors] = useState<Record<number, string>>({})
  const [autoGrading, setAutoGrading] = useState(false)

  useEffect(() => {
    if (!examId || !submissionId) return
    Promise.all([
      getExam(Number(examId)),
      getSubmission(Number(submissionId)),
    ])
      .then(([e, s]) => {
        setExam(e)
        setSubmission(s)
        const initial: Record<number, LocalGrade> = {}
        for (const a of s.answers ?? []) {
          initial[a.id] = {
            score:    a.score != null ? String(a.score) : '',
            feedback: a.feedback ?? '',
          }
        }
        setGrades(initial)
      })
      .catch(() => setError('Failed to load submission.'))
      .finally(() => setLoading(false))
  }, [examId, submissionId])

  // Validate score against question bounds and update grade + error state.
  const updateGrade = useCallback((answerId: number, maxPts: number, g: LocalGrade) => {
    const parsed = parseFloat(g.score)
    let errMsg = ''
    if (g.score !== '' && !isNaN(parsed)) {
      if (parsed < 0) {
        errMsg = 'Error: Awarded marks cannot be negative.'
      } else if (parsed > maxPts) {
        errMsg = `Error: Awarded marks cannot exceed the maximum limit (${maxPts}).`
      }
    }
    if (errMsg) {
      setScoreErrors(prev => ({ ...prev, [answerId]: errMsg }))
    } else {
      setScoreErrors(prev => {
        const next = { ...prev }
        delete next[answerId]
        return next
      })
    }
    setGrades(prev => ({ ...prev, [answerId]: g }))
  }, [])

  const handleSave = useCallback(async () => {
    if (!submission || !exam) return

    if (Object.keys(scoreErrors).length > 0) {
      setError('Please fix the marks validation errors before saving.')
      return
    }

    setSaving(true)
    setSaved(false)
    setError('')

    const qMap = buildQuestionMap(exam)
    const gradesToSend = (submission.answers ?? [])
      .filter(a => {
        const q = qMap[a.question_id]
        return q?.type === 'theory' || q?.type === 'code'
      })
      .map(a => {
        const g = grades[a.id]
        return {
          answer_id: a.id,
          score:     parseFloat(g?.score ?? '0') || 0,
          feedback:  g?.feedback ?? '',
        }
      })

    try {
      const updated = await gradeSubmission(submission.id, gradesToSend)
      setSubmission(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch {
      setError('Failed to save grades. Please try again.')
    } finally {
      setSaving(false)
    }
  }, [submission, grades, scoreErrors, exam])

  const handleAutoGrade = useCallback(async () => {
    if (!submission) return
    setAutoGrading(true)
    setError('')
    try {
      const result = await autoGradeSubmission(submission.id)
      setSubmission(result.submission)
      // Refresh local grades from the updated answers
      const updated: Record<number, LocalGrade> = {}
      for (const a of result.submission.answers ?? []) {
        updated[a.id] = {
          score: a.score != null ? String(a.score) : '',
          feedback: a.feedback ?? '',
        }
      }
      setGrades(updated)
    } catch {
      setError('AI grading failed. Is the LLM service running?')
    } finally {
      setAutoGrading(false)
    }
  }, [submission])

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={{ minHeight: '100vh', background: 'var(--page-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: muted, fontFamily: 'system-ui, sans-serif' }}>
      Loading submission…
    </div>
  )
  if (error && !submission) return (
    <div style={{ minHeight: '100vh', background: 'var(--page-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626', fontFamily: 'system-ui, sans-serif' }}>
      {error}
    </div>
  )
  if (!submission || !exam) return null

  const questionMap = buildQuestionMap(exam)
  const answers     = submission.answers ?? []
  const hasErrors   = Object.keys(scoreErrors).length > 0

  const autoGraded    = answers.filter(a => { const q = questionMap[a.question_id]; return q?.type === 'MCQ' || q?.type === 'MRQ' })
  const manualAnswers = answers.filter(a => { const q = questionMap[a.question_id]; return q?.type === 'theory' || q?.type === 'code' })

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--page-bg)', transition: 'background 0.2s',
    }}>
    <div style={{
      maxWidth: 960, margin: '0 auto', padding: '32px 24px 64px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      {/* ── Breadcrumb ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, fontSize: 13, color: muted }}>
        <Link to="/dashboard" style={{ color: muted, textDecoration: 'none' }}>Dashboard</Link>
        <span>›</span>
        <Link to={`/exams/${examId}?tab=submissions`} style={{ color: muted, textDecoration: 'none' }}>{exam.title}</Link>
        <span>›</span>
        <span style={{ color: text }}>Grade Submission</span>
      </div>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: text }}>
            {submission.student_name}
          </h2>
          <p style={{ margin: '0 0 6px', fontSize: 14, color: muted }}>
            {submission.student_email} · Submitted {new Date(submission.submitted_at).toLocaleString()}
          </p>
          {submission.set_name && (
            <div style={{ marginBottom: 8 }}>
              <span style={{
                fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 6,
                background: '#ede9fe', color: '#6d28d9', display: 'inline-flex',
                alignItems: 'center', gap: 5,
              }}>
                📋 Assigned Set: {submission.set_name}
              </span>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <StatusBadge status={submission.status} />
            <span style={{ fontSize: 14, fontWeight: 700, color: '#1a73e8' }}>
              Total: {submission.total_score} pts
            </span>
          </div>
        </div>

        {/* Right-side actions */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <Link to={`/exams/${examId}?tab=submissions`} style={{ textDecoration: 'none' }}>
            <button style={{
              padding: '8px 18px', fontSize: 13, fontWeight: 600,
              background: isDark ? '#334155' : '#f3f4f6',
              color: isDark ? '#e2e8f0' : '#374151',
              border: `1px solid ${isDark ? '#475569' : '#d1d5db'}`,
              borderRadius: 7, cursor: 'pointer',
            }}>
              ← Back to Results
            </button>
          </Link>
          <button
            onClick={handleAutoGrade}
            disabled={autoGrading || manualAnswers.length === 0}
            style={{
              padding: '10px 22px', fontSize: 14, fontWeight: 700,
              background: autoGrading ? '#a78bfa' : manualAnswers.length === 0 ? '#d1d5db' : '#7c3aed',
              color: 'white', border: 'none', borderRadius: 7,
              cursor: (autoGrading || manualAnswers.length === 0) ? 'not-allowed' : 'pointer',
            }}
          >
            {autoGrading ? '⏳ AI Grading…' : '🤖 AI Auto Grade'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || manualAnswers.length === 0 || hasErrors}
            style={{
              padding: '10px 28px', fontSize: 14, fontWeight: 700,
              background: saving ? '#93c5fd' : (manualAnswers.length === 0 || hasErrors) ? '#d1d5db' : '#1a73e8',
              color: 'white', border: 'none', borderRadius: 7,
              cursor: (saving || manualAnswers.length === 0 || hasErrors) ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Saving…' : 'Save Grades'}
          </button>
          {saved && <span style={{ fontSize: 13, color: '#15803d', fontWeight: 600 }}>✓ Saved successfully</span>}
          {error && <span style={{ fontSize: 13, color: '#dc2626', maxWidth: 240, textAlign: 'right' }}>{error}</span>}
          {manualAnswers.length === 0 && (
            <span style={{ fontSize: 12, color: '#9ca3af' }}>All answers are auto-graded</span>
          )}
        </div>
      </div>

      {/* ── Auto-graded section ─────────────────────────────────────────── */}
      {autoGraded.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: text,
            paddingBottom: 8, borderBottom: `2px solid ${border}` }}>
            Auto-Graded Questions ({autoGraded.length})
          </h3>
          {autoGraded.map(a => (
            <AnswerCard
              key={a.id}
              answer={a}
              question={questionMap[a.question_id]}
              grade={grades[a.id] ?? { score: String(a.score ?? ''), feedback: '' }}
              scoreError={scoreErrors[a.id] ?? ''}
              onChange={g => updateGrade(a.id, questionMap[a.question_id]?.points ?? 0, g)}
              isDark={isDark}
            />
          ))}
        </section>
      )}

      {/* ── Manual grading section ──────────────────────────────────────── */}
      {manualAnswers.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: text,
            paddingBottom: 8, borderBottom: `2px solid ${border}` }}>
            Manual Grading Required ({manualAnswers.length})
          </h3>
          {manualAnswers.map(a => (
            <AnswerCard
              key={a.id}
              answer={a}
              question={questionMap[a.question_id]}
              grade={grades[a.id] ?? { score: '', feedback: '' }}
              scoreError={scoreErrors[a.id] ?? ''}
              onChange={g => updateGrade(a.id, questionMap[a.question_id]?.points ?? 0, g)}
              isDark={isDark}
            />
          ))}
        </section>
      )}

      {answers.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: muted,
          border: `2px dashed ${border}`, borderRadius: 10 }}>
          No answers recorded for this submission.
        </div>
      )}

      {/* Bottom back + save row */}
      {(manualAnswers.length > 0 || autoGraded.length > 0) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          paddingTop: 16, borderTop: `1px solid ${border}` }}>
          <Link to={`/exams/${examId}?tab=submissions`} style={{ textDecoration: 'none' }}>
            <button style={{
              padding: '10px 20px', fontSize: 14, fontWeight: 600,
              background: isDark ? '#334155' : '#f3f4f6',
              color: isDark ? '#e2e8f0' : '#374151',
              border: `1px solid ${isDark ? '#475569' : '#d1d5db'}`,
              borderRadius: 7, cursor: 'pointer',
            }}>
              ← Back to Results
            </button>
          </Link>
          {manualAnswers.length > 0 && (
            <button
              onClick={handleSave}
              disabled={saving || hasErrors}
              style={{
                padding: '11px 32px', fontSize: 14, fontWeight: 700,
                background: (saving || hasErrors) ? '#d1d5db' : '#1a73e8',
                color: 'white', border: 'none', borderRadius: 7,
                cursor: (saving || hasErrors) ? 'not-allowed' : 'pointer',
              }}
            >
              {saving ? 'Saving…' : 'Save Grades'}
            </button>
          )}
        </div>
      )}
    </div>
    </div>
  )
}
