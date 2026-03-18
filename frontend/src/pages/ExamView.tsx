import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import {
  getExam, createQuestionSet, deleteQuestionSet, duplicateQuestionSet,
  createQuestion, deleteQuestion, updateQuestion,
  getSubmissions, getSubmission, deleteSubmission, uploadQuestions, toggleExamStatus, importOfflineAuto,
  exportAllSubmissions, importAllSubmissions, autoGradeAllSubmissions,
  getMailSettings, sendReport, sendAllReports,
  UploadResult, Exam, Question, QuestionSet, Submission,
} from '../api/client'
import { generateStudentPDF } from '../utils/generateStudentPDF'
import { useTheme } from '../contexts/ThemeContext'
import ResultsAnalytics from './ResultsAnalytics'

// ── Shared style helpers ───────────────────────────────────────────────────────

const card: CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginBottom: 12,
  background: 'var(--card-bg)',
}

const btn = (variant: 'primary' | 'danger' | 'ghost' | 'outline' = 'ghost'): CSSProperties => ({
  padding: '5px 12px',
  border: variant === 'outline' ? '1px solid var(--border)' : 'none',
  borderRadius: 5, fontSize: 13, cursor: 'pointer', fontWeight: 500,
  background:
    variant === 'primary' ? '#1a73e8'
    : variant === 'danger'  ? '#fee2e2'
    : 'var(--card-bg2)',
  color:
    variant === 'primary' ? 'white'
    : variant === 'danger'  ? '#dc2626'
    : 'var(--text)',
})

const inputStyle: CSSProperties = {
  padding: '7px 10px', border: '1px solid var(--input-border)', borderRadius: 5,
  fontSize: 14, width: '100%', boxSizing: 'border-box',
  background: 'var(--input-bg)', color: 'var(--text)',
}

const badgeStyle = (color: string): CSSProperties => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 9999,
  fontSize: 11, fontWeight: 600, background: color, marginRight: 6,
})

// ── Type badge ────────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: Question['type'] }) {
  const { isDark } = useTheme()
  const cfg: Record<Question['type'], { label: string; bg: string; bgDark: string; color: string; colorDark: string }> = {
    MCQ:    { label: 'MCQ',    bg: '#dbeafe', bgDark: '#1e3a5f', color: '#1d4ed8', colorDark: '#93c5fd' },
    MRQ:    { label: 'MRQ',    bg: '#ede9fe', bgDark: '#2e1065', color: '#6d28d9', colorDark: '#c4b5fd' },
    code:   { label: 'Code',   bg: '#dcfce7', bgDark: '#14532d', color: '#15803d', colorDark: '#86efac' },
    theory: { label: 'Theory', bg: '#fef3c7', bgDark: '#451a03', color: '#92400e', colorDark: '#fcd34d' },
  }
  const { label, bg, bgDark, color, colorDark } = cfg[type] ?? { label: type, bg: 'var(--card-bg2)', bgDark: 'var(--card-bg2)', color: 'var(--text)', colorDark: 'var(--text)' }
  return <span style={{ ...badgeStyle(isDark ? bgDark : bg), color: isDark ? colorDark : color }}>{label}</span>
}

// ── Toggle (small inline) ─────────────────────────────────────────────────────

function SmallToggle({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{
          width: 34, height: 20, borderRadius: 10, border: 'none', flexShrink: 0,
          background: checked ? '#1a73e8' : '#d1d5db',
          position: 'relative', cursor: 'pointer', transition: 'background 0.15s',
        }}
      >
        <span style={{
          position: 'absolute', top: 2, left: checked ? 16 : 2, width: 16, height: 16,
          borderRadius: '50%', background: 'white',
          boxShadow: '0 1px 2px rgba(0,0,0,0.25)', transition: 'left 0.15s', display: 'block',
        }} />
      </button>
      <span style={{ fontSize: 13, color: 'var(--text)' }}>{label}</span>
    </label>
  )
}

// ── AddQuestionForm ───────────────────────────────────────────────────────────

interface AddQuestionFormProps {
  questionSetId: number
  onAdded: () => void
  onCancel: () => void
}

function AddQuestionForm({ questionSetId, onAdded, onCancel }: AddQuestionFormProps) {
  // Base type selected by the teacher (MCQ / theory / code).
  // The actual saved type auto-upgrades to MRQ when >1 correct answer is checked.
  const [baseType, setBaseType] = useState<'MCQ' | 'theory' | 'code'>('MCQ')
  const [content, setContent] = useState('')
  const [points, setPoints] = useState(10)
  const [randomizeOptions, setRandomizeOptions] = useState(false)
  const [language, setLanguage] = useState('python')

  // Dynamic options list (MCQ / MRQ)
  const [options, setOptions] = useState<string[]>(['', '', '', ''])
  // Set of checked correct-answer option values
  const [correctSet, setCorrectSet] = useState<Set<string>>(new Set())

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const filledOptions = options.filter(o => o.trim())
  // Auto-detect MRQ when the teacher checks multiple correct answers
  const resolvedType: Question['type'] = baseType === 'MCQ' && correctSet.size > 1 ? 'MRQ' : baseType

  const addOption = () => setOptions(prev => [...prev, ''])

  const removeOption = (i: number) => {
    const removed = options[i]
    setOptions(prev => prev.filter((_, idx) => idx !== i))
    setCorrectSet(prev => { const s = new Set(prev); s.delete(removed); return s })
  }

  const updateOption = (i: number, val: string) => {
    const old = options[i]
    setOptions(prev => prev.map((o, idx) => idx === i ? val : o))
    // Keep correctSet up-to-date if the teacher edits an already-checked option
    if (correctSet.has(old)) {
      setCorrectSet(prev => { const s = new Set(prev); s.delete(old); if (val.trim()) s.add(val); return s })
    }
  }

  const toggleCorrect = (opt: string) => {
    if (!opt.trim()) return
    setCorrectSet(prev => {
      const s = new Set(prev)
      s.has(opt) ? s.delete(opt) : s.add(opt)
      return s
    })
  }

  const handleSubmit = async () => {
    setError('')
    if (!content.trim()) { setError('Question content is required.'); return }
    if (points < 1) { setError('Marks must be at least 1.'); return }

    if (baseType === 'MCQ') {
      if (filledOptions.length < 2) { setError('Provide at least 2 answer options.'); return }
      const seen = new Set<string>()
      for (const opt of filledOptions) {
        if (seen.has(opt)) { setError(`Duplicate option "${opt}" — each option must be unique.`); return }
        seen.add(opt)
      }
      if (correctSet.size === 0) { setError('Mark at least one correct answer.'); return }
      const invalidCorrect = [...correctSet].filter(c => !filledOptions.includes(c))
      if (invalidCorrect.length > 0) { setError('A correct answer was removed from the options list.'); return }
    }

    setSaving(true)
    try {
      await createQuestion({
        question_set_id: questionSetId,
        type: resolvedType,
        content: content.trim(),
        points,
        language: baseType === 'code' ? language : '',
        randomize_options: baseType === 'MCQ' ? randomizeOptions : false,
        options: baseType === 'MCQ' ? filledOptions : undefined,
        correct_answers: baseType === 'MCQ' ? [...correctSet] : undefined,
      })
      onAdded()
    } catch {
      setError('Failed to add question. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ background: 'var(--card-bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginTop: 12 }}>
      <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
        Add Question
        {resolvedType === 'MRQ' && (
          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: '#6d28d9',
            background: '#ede9fe', padding: '2px 7px', borderRadius: 9999 }}>
            Multiple Response (MRQ)
          </span>
        )}
      </h4>

      {/* Type selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {(['MCQ', 'theory', 'code'] as const).map(t => (
          <button key={t} type="button" onClick={() => setBaseType(t)} style={{
            ...btn(baseType === t ? 'primary' : 'ghost'),
          }}>
            {t === 'MCQ' ? 'MCQ / MRQ' : t === 'theory' ? 'Theory' : 'Coding'}
          </button>
        ))}
      </div>

      {/* Language selector — code questions only */}
      {baseType === 'code' && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 5 }}>
            Programming Language <span style={{ color: '#ef4444' }}>*</span>
          </label>
          <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden', width: 'fit-content' }}>
            {([['python', 'Python 3'], ['c', 'C'], ['cpp', 'C++ 17']] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setLanguage(val)}
                style={{
                  padding: '6px 16px', border: 'none', fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', transition: 'background 0.1s',
                  background: language === val ? '#1e293b' : 'var(--card-bg)',
                  color: language === val ? '#4ade80' : 'var(--text)',
                  borderRight: val !== 'cpp' ? '1px solid var(--border)' : 'none',
                  fontFamily: language === val ? 'monospace' : 'inherit',
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
            Students will see this language locked — they cannot switch.
          </p>
        </div>
      )}

      {/* Content */}
      <div style={{ marginBottom: 10 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
          Question Content *
        </label>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={3}
          placeholder={
            baseType === 'code'   ? 'Describe the coding problem…'
            : baseType === 'theory' ? 'Ask an open-ended question…'
            : 'Write the question…'
          }
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
        />
      </div>

      {/* MCQ/MRQ options */}
      {baseType === 'MCQ' && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
              Answer Options (≥ 2) — check all correct answers
            </label>
            <button type="button" onClick={addOption} style={{ ...btn('outline'), fontSize: 12 }}>
              + Add Option
            </button>
          </div>

          {options.map((opt, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              {/* Correct-answer checkbox */}
              <input
                type="checkbox"
                title="Mark as correct answer"
                checked={correctSet.has(opt) && opt.trim() !== ''}
                onChange={() => toggleCorrect(opt)}
                disabled={!opt.trim()}
                style={{ width: 16, height: 16, flexShrink: 0, accentColor: '#15803d', cursor: 'pointer' }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 18, flexShrink: 0 }}>
                {String.fromCharCode(65 + i)}.
              </span>
              <input
                value={opt}
                onChange={e => updateOption(i, e.target.value)}
                placeholder={`Option ${String.fromCharCode(65 + i)}`}
                style={{ ...inputStyle, flex: 1 }}
              />
              {options.length > 2 && (
                <button type="button" onClick={() => removeOption(i)}
                  style={{ ...btn('danger'), padding: '4px 8px', flexShrink: 0 }}>
                  ×
                </button>
              )}
            </div>
          ))}

          {correctSet.size === 0 && filledOptions.length >= 2 && (
            <p style={{ fontSize: 12, color: '#92400e', margin: '4px 0 0' }}>
              ☑ Check at least one option as the correct answer.
            </p>
          )}
          {correctSet.size > 1 && (
            <p style={{ fontSize: 12, color: '#6d28d9', margin: '4px 0 0' }}>
              Multiple answers checked → this will be saved as a <strong>Multiple Response (MRQ)</strong> question.
            </p>
          )}

          {/* Randomize options toggle */}
          <div style={{ marginTop: 10 }}>
            <SmallToggle
              label="Shuffle option order for each student"
              checked={randomizeOptions}
              onChange={setRandomizeOptions}
            />
          </div>
        </div>
      )}

      {/* Marks */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
          Marks <span style={{ color: '#ef4444' }}>*</span>
        </label>
        <input
          type="number" min={1} max={100} value={points}
          onChange={e => setPoints(Math.max(1, Number(e.target.value)))}
          style={{ ...inputStyle, width: 80, border: points < 1 ? '1px solid #dc2626' : '1px solid #d1d5db' }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>min 1</span>
      </div>

      {error && <p style={{ color: '#dc2626', fontSize: 13, marginBottom: 8 }}>⚠ {error}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={handleSubmit} disabled={saving} style={btn('primary')}>
          {saving ? 'Adding…' : 'Add Question'}
        </button>
        <button type="button" onClick={onCancel} style={btn()}>Cancel</button>
      </div>
    </div>
  )
}

// ── SecurityBar ───────────────────────────────────────────────────────────────

function SecurityBar({ exam }: { exam: Exam }) {
  const { isDark } = useTheme()
  const badges: { label: string; active: boolean; color: string; colorDark: string }[] = [
    { label: `⏱ ${exam.duration_minutes} min`, active: true, color: '#e0f2fe', colorDark: '#0c4a6e' },
    { label: '⇄ Randomized Questions', active: exam.randomize_question_order, color: '#e0e7ff', colorDark: '#1e1b4b' },
    { label: '📷 Camera', active: exam.camera_proctoring_required, color: '#fce7f3', colorDark: '#4a044e' },
    { label: `⚠ Limit ${exam.violation_limit}`, active: exam.violation_limit > 0, color: '#fef3c7', colorDark: '#451a03' },
    {
      label: exam.max_code_runs === 0 ? 'No Code Execution' : `Max ${exam.max_code_runs} Run${exam.max_code_runs > 1 ? 's' : ''}`,
      active: true,
      color: exam.max_code_runs > 0 ? '#dcfce7' : '#fee2e2',
      colorDark: exam.max_code_runs > 0 ? '#14532d' : '#450a0a',
    },
  ]
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
      {badges.filter(b => b.active).map(b => (
        <span key={b.label} style={{ ...badgeStyle(isDark ? b.colorDark : b.color), color: 'var(--text-body)', fontSize: 12 }}>
          {b.label}
        </span>
      ))}
    </div>
  )
}

// ── Duplicate set modal ───────────────────────────────────────────────────────

function DuplicateSetModal({ suggestedName, onConfirm, onCancel, duplicating }: {
  suggestedName: string
  onConfirm: (name: string) => void
  onCancel: () => void
  duplicating: boolean
}) {
  const [name, setName] = useState(suggestedName)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && name.trim()) onConfirm(name.trim())
    if (e.key === 'Escape') onCancel()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, backdropFilter: 'blur(3px)',
    }}>
      <div style={{
        background: 'var(--card-bg)', borderRadius: 12, padding: '28px 24px',
        maxWidth: 420, width: '100%',
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }}>
        <div style={{ fontSize: 32, textAlign: 'center', marginBottom: 10 }}>⊕</div>
        <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700, color: 'var(--text)', textAlign: 'center' }}>
          Duplicate Question Set
        </h3>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
          All questions will be copied into the new set.
        </p>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
          Name for New Set
        </label>
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Set B"
          style={{ ...inputStyle, marginBottom: 20 }}
        />
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onCancel}
            disabled={duplicating}
            style={{
              flex: 1, padding: '10px 0', background: 'var(--card-bg2)',
              border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 600,
              cursor: 'pointer', color: 'var(--text)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => name.trim() && onConfirm(name.trim())}
            disabled={duplicating || !name.trim()}
            style={{
              flex: 1, padding: '10px 0',
              background: duplicating || !name.trim() ? '#93c5fd' : '#1a73e8',
              border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 700,
              cursor: duplicating || !name.trim() ? 'not-allowed' : 'pointer', color: 'white',
            }}
          >
            {duplicating ? 'Duplicating…' : 'Create Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Edit question modal ────────────────────────────────────────────────────────

function EditQuestionModal({ question, onSaved, onCancel }: {
  question: Question
  onSaved: (updated: Question) => void
  onCancel: () => void
}) {
  const isChoiceOrigin = question.type === 'MCQ' || question.type === 'MRQ'
  const isCodeOrigin   = question.type === 'code'

  // editType is mutable for MCQ↔MRQ; locked for theory/code.
  const [editType, setEditType] = useState<Question['type']>(question.type)
  const [codeLanguage, setCodeLanguage] = useState(question.language ?? 'python')
  const [content, setContent] = useState(question.content)
  const [points, setPoints] = useState(question.points)
  const [randomizeOptions, setRandomizeOptions] = useState(question.randomize_options)
  const [options, setOptions] = useState<string[]>((question.options as unknown as string[]) ?? [])
  const [correctSet, setCorrectSet] = useState<Set<string>>(new Set(question.correct_answers ?? []))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleTypeChange = (newType: 'MCQ' | 'MRQ') => {
    setEditType(newType)
    // Switching to MCQ (single-choice): keep only the first correct answer.
    if (newType === 'MCQ' && correctSet.size > 1) {
      setCorrectSet(new Set([[...correctSet][0]]))
    }
  }

  const addOption = () => setOptions(prev => [...prev, ''])

  const removeOption = (i: number) => {
    const removed = options[i]
    setOptions(prev => prev.filter((_, idx) => idx !== i))
    setCorrectSet(prev => { const s = new Set(prev); s.delete(removed); return s })
  }

  const updateOption = (i: number, val: string) => {
    const old = options[i]
    setOptions(prev => prev.map((o, idx) => idx === i ? val : o))
    if (correctSet.has(old)) {
      setCorrectSet(prev => { const s = new Set(prev); s.delete(old); if (val.trim()) s.add(val); return s })
    }
  }

  // MCQ: radio — select exactly one answer.
  const selectSingle = (opt: string) => {
    if (!opt.trim()) return
    setCorrectSet(new Set([opt]))
  }

  // MRQ: checkbox — toggle membership.
  const toggleCorrect = (opt: string) => {
    if (!opt.trim()) return
    setCorrectSet(prev => {
      const s = new Set(prev)
      s.has(opt) ? s.delete(opt) : s.add(opt)
      return s
    })
  }

  const handleSave = async () => {
    setError('')
    if (!content.trim()) { setError('Content is required.'); return }
    if (points < 1) { setError('Marks must be at least 1.'); return }
    if (isChoiceOrigin) {
      const filledOpts = options.filter(o => o.trim())
      if (filledOpts.length < 2) { setError('Provide at least 2 answer options.'); return }
      if (correctSet.size === 0) { setError('Mark at least one correct answer.'); return }
      if (editType === 'MCQ' && correctSet.size > 1) { setError('MCQ allows only one correct answer.'); return }
    }
    setSaving(true)
    try {
      const filledOpts = options.filter(o => o.trim())
      const updated = await updateQuestion(question.id, {
        type: editType,
        content: content.trim(),
        points,
        language: isCodeOrigin ? codeLanguage : '',
        randomize_options: isChoiceOrigin ? randomizeOptions : false,
        options: isChoiceOrigin ? filledOpts : null,
        correct_answers: isChoiceOrigin ? [...correctSet] : undefined,
      })
      onSaved(updated)
    } catch {
      setError('Failed to save changes. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, backdropFilter: 'blur(3px)',
    }}>
      <div style={{
        background: 'var(--card-bg)', borderRadius: 12, padding: '28px 24px',
        maxWidth: 560, width: '100%', maxHeight: '85vh', overflowY: 'auto',
        boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
      }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Edit Question</h3>

        {/* MCQ ↔ MRQ type toggle (only for choice questions) */}
        {isChoiceOrigin && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
              Question Type
            </label>
            <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden', width: 'fit-content' }}>
              {(['MCQ', 'MRQ'] as const).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => handleTypeChange(t)}
                  style={{
                    padding: '7px 20px', border: 'none', fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', transition: 'background 0.1s, color 0.1s',
                    background: editType === t ? '#1a73e8' : 'var(--card-bg2)',
                    color: editType === t ? 'white' : 'var(--text)',
                    borderRight: t === 'MCQ' ? '1px solid var(--border)' : 'none',
                  }}
                >
                  {t === 'MCQ' ? 'MCQ — Single Choice' : 'MRQ — Multiple Choice'}
                </button>
              ))}
            </div>
            {editType === 'MCQ' && (
              <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
                Only one answer can be marked correct.
              </p>
            )}
            {editType === 'MRQ' && (
              <p style={{ margin: '6px 0 0', fontSize: 11, color: '#6d28d9' }}>
                Students must select all correct answers to earn marks.
              </p>
            )}
          </div>
        )}

        {/* Locked type indicator for theory / code */}
        {!isChoiceOrigin && (
          <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <TypeBadge type={editType} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>type is locked for {editType} questions</span>
          </div>
        )}

        {/* Language selector for code questions */}
        {isCodeOrigin && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
              Programming Language
            </label>
            <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden', width: 'fit-content' }}>
              {(['python', 'c', 'cpp'] as const).map((lang, i, arr) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => setCodeLanguage(lang)}
                  style={{
                    padding: '7px 18px', border: 'none', fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', transition: 'background 0.1s, color 0.1s',
                    background: codeLanguage === lang ? '#1a73e8' : 'var(--card-bg2)',
                    color: codeLanguage === lang ? 'white' : 'var(--text)',
                    borderRight: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  {lang === 'python' ? 'Python 3' : lang === 'c' ? 'C' : 'C++ 17'}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Content */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
            Question Content *
          </label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>

        {/* Options (MCQ / MRQ) */}
        {isChoiceOrigin && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                {editType === 'MCQ'
                  ? 'Options — select the one correct answer'
                  : 'Options — check all correct answers'}
              </label>
              <button type="button" onClick={addOption} style={{ ...btn('outline'), fontSize: 12 }}>
                + Add Option
              </button>
            </div>
            {options.map((opt, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                {editType === 'MCQ' ? (
                  <input
                    type="radio"
                    name="edit-correct-answer"
                    checked={correctSet.has(opt) && opt.trim() !== ''}
                    onChange={() => selectSingle(opt)}
                    disabled={!opt.trim()}
                    style={{ width: 16, height: 16, flexShrink: 0, accentColor: '#1a73e8', cursor: 'pointer' }}
                  />
                ) : (
                  <input
                    type="checkbox"
                    checked={correctSet.has(opt) && opt.trim() !== ''}
                    onChange={() => toggleCorrect(opt)}
                    disabled={!opt.trim()}
                    style={{ width: 16, height: 16, flexShrink: 0, accentColor: '#15803d', cursor: 'pointer' }}
                  />
                )}
                <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 18, flexShrink: 0 }}>
                  {String.fromCharCode(65 + i)}.
                </span>
                <input
                  value={opt}
                  onChange={e => updateOption(i, e.target.value)}
                  style={{ ...inputStyle, flex: 1 }}
                />
                {options.length > 2 && (
                  <button type="button" onClick={() => removeOption(i)}
                    style={{ ...btn('danger'), padding: '4px 8px', flexShrink: 0 }}>
                    ×
                  </button>
                )}
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              <SmallToggle
                label="Shuffle option order for each student"
                checked={randomizeOptions}
                onChange={setRandomizeOptions}
              />
            </div>
          </div>
        )}

        {/* Marks */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Marks *</label>
          <input
            type="number" min={1} max={100} value={points}
            onChange={e => setPoints(Math.max(1, Number(e.target.value)))}
            style={{ ...inputStyle, width: 80 }}
          />
        </div>

        {error && <p style={{ color: '#dc2626', fontSize: 13, marginBottom: 10 }}>⚠ {error}</p>}

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={handleSave} disabled={saving} style={btn('primary')}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
          <button type="button" onClick={onCancel} style={btn()}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Question row in the teacher list ──────────────────────────────────────────

function QuestionRow({ q, idx, onDelete, onEdit, locked }: {
  q: Question; idx: number; onDelete: () => void; onEdit: () => void; locked?: boolean
}) {
  const opts = q.options as unknown as string[] | null
  const correct = q.correct_answers ?? []

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '10px 12px', background: 'var(--card-bg2)', borderRadius: 6, marginBottom: 8,
    }}>
      <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 24, paddingTop: 1 }}>{idx + 1}.</span>

      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, flexWrap: 'wrap' }}>
          <TypeBadge type={q.type} />
          {q.randomize_options && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--card-bg)',
              padding: '1px 6px', borderRadius: 9999 }}>
              ⇄ shuffled
            </span>
          )}
        </div>

        <p style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--text-body)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
          <span style={{
            display: 'inline-block', marginRight: 7,
            fontSize: 12, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
            background: '#fef9c3', color: '#854d0e', verticalAlign: 'middle',
          }}>
            [{q.points} {q.points !== 1 ? 'Marks' : 'Mark'}]
          </span>
          {q.content}
        </p>

        {/* Options with correct-answer highlighting */}
        {(q.type === 'MCQ' || q.type === 'MRQ') && opts && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 4 }}>
            {opts.map((opt, i) => {
              const isCorrect = correct.includes(opt)
              return (
                <span key={i} style={{
                  fontSize: 12, padding: '2px 8px', borderRadius: 4,
                  background: isCorrect ? '#dcfce7' : 'var(--card-bg)',
                  color: isCorrect ? '#15803d' : 'var(--text)',
                  fontWeight: isCorrect ? 600 : 400,
                }}>
                  {opt}{isCorrect ? ' ✓' : ''}
                </span>
              )
            })}
          </div>
        )}
      </div>

      {!locked && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button onClick={onEdit} title="Edit question" style={{ ...btn(), padding: '4px 8px' }}>✎</button>
          <button onClick={onDelete} style={btn('danger')}>×</button>
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

// ── CSV upload helpers ────────────────────────────────────────────────────────

const CSV_TEMPLATE =
  'Question Text,Type,Options,Correct Answers,Randomize Options,Marks,Language\n' +
  '"What is 2+2?",MCQ,"3|4|5|6","4",false,5,\n' +
  '"Which are prime?",MRQ,"2|3|4|5","2|3|5",true,10,\n' +
  '"Describe recursion.",theory,,,false,15,\n' +
  '"Write a function that returns the sum of two numbers.",code,,,false,20,py\n'

const LANG_EXT: Record<string, string> = { python: 'py', c: 'c', cpp: 'cpp' }

function downloadTemplate() {
  const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'questions_template.csv'
  a.click()
  URL.revokeObjectURL(url)
}

function exportSetAsCSV(qs: QuestionSet) {
  const escape = (s: string) => '"' + s.replace(/"/g, '""') + '"'
  const header = 'Question Text,Type,Options,Correct Answers,Randomize Options,Marks,Language'
  const rows = (qs.questions ?? []).map((q: Question) => {
    const options = (q.options ?? []).join('|')
    const correct = (q.correct_answers ?? []).join('|')
    const lang = q.type === 'code' ? (LANG_EXT[q.language ?? ''] ?? q.language ?? '') : ''
    return [
      escape(q.content),
      q.type,
      options ? escape(options) : '',
      correct ? escape(correct) : '',
      String(q.randomize_options),
      String(q.points),
      lang,
    ].join(',')
  })
  const csv = [header, ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = qs.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_questions.csv'
  a.click()
  URL.revokeObjectURL(url)
}

interface SetUploadState {
  loading: boolean
  result?: UploadResult
  error?: string
}

// ── Confirmation modal ────────────────────────────────────────────────────────

function ConfirmModal({
  message, onConfirm, onCancel, confirming,
}: {
  message: ReactNode
  onConfirm: () => void
  onCancel: () => void
  confirming: boolean
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, backdropFilter: 'blur(3px)',
    }}>
      <div style={{
        background: 'var(--card-bg)', borderRadius: 12, padding: '32px 28px',
        maxWidth: 420, width: '100%',
        boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
      }}>
        <div style={{ fontSize: 40, marginBottom: 12, textAlign: 'center' }}>🗑️</div>
        <h3 style={{ margin: '0 0 12px', fontSize: 17, fontWeight: 700, color: 'var(--text)', textAlign: 'center' }}>
          Delete Submission?
        </h3>
        <p style={{ margin: '0 0 24px', fontSize: 14, color: 'var(--text-body)', lineHeight: 1.6, textAlign: 'center' }}>
          {message}
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onCancel}
            disabled={confirming}
            style={{
              flex: 1, padding: '10px 0', background: 'var(--card-bg2)',
              border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 600,
              cursor: 'pointer', color: 'var(--text)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={confirming}
            style={{
              flex: 1, padding: '10px 0',
              background: confirming ? '#fca5a5' : '#dc2626',
              border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 700,
              cursor: confirming ? 'not-allowed' : 'pointer', color: 'white',
            }}
          >
            {confirming ? 'Deleting…' : 'Yes, Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Toast notification ────────────────────────────────────────────────────────

function Toast({ message, type }: { message: string; type: 'success' | 'error' }) {
  return (
    <>
      <style>{`
        @keyframes exam-toast-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        .exam-toast { animation: exam-toast-in 0.2s ease; }
      `}</style>
      <div className="exam-toast" style={{
        position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
        background: type === 'error' ? '#dc2626' : '#15803d',
        color: 'white', borderRadius: 8, padding: '12px 18px',
        fontSize: 14, fontWeight: 600,
        boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span>{type === 'error' ? '✕' : '✓'}</span>
        {message}
      </div>
    </>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ExamView() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const { isDark } = useTheme()
  const [exam, setExam] = useState<Exam | null>(null)
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [subPage, setSubPage] = useState(1)
  const SUB_PER_PAGE = 10
  const [newSetTitle, setNewSetTitle] = useState('')
  const [addingSetTo, setAddingSetTo] = useState<number | null>(null)
  const initialTab = (searchParams.get('tab') as 'questions' | 'submissions' | 'analytics') || 'questions'
  const [activeTab, setActiveTab] = useState<'questions' | 'submissions' | 'analytics'>(initialTab)
  const [uploadStates, setUploadStates] = useState<Record<number, SetUploadState>>({})
  const [collapsedSets, setCollapsedSets] = useState<Set<number>>(new Set())
  const fileInputRefs = useRef<Record<number, HTMLInputElement | null>>({})
  const [togglingStatus, setTogglingStatus] = useState(false)
  const [timeLeft, setTimeLeft] = useState<number | null>(null) // seconds remaining, null when inactive

  // Submission deletion state
  const [confirmDelete, setConfirmDelete] = useState<Submission | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

  // Question editing state
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null)

  // Duplicate-set modal state
  const [duplicatingSet, setDuplicatingSet] = useState<{ id: number; suggestedName: string } | null>(null)
  const [duplicating, setDuplicating] = useState(false)

  // Offline import state
  const offlineInputRef = useRef<HTMLInputElement>(null)
  const [importingOffline, setImportingOffline] = useState(false)

  // Bulk export / import state
  const bulkInputRef = useRef<HTMLInputElement>(null)
  const [exporting, setExporting] = useState(false)
  const [bulkImporting, setBulkImporting] = useState(false)

  // AI auto-grade state
  const [aiGradingAll, setAiGradingAll] = useState(false)

  // Mail / report state
  const [mailConfigured, setMailConfigured] = useState(false)
  const [sendingReports, setSendingReports] = useState<Set<number>>(new Set())
  const [bulkSending, setBulkSending] = useState(false)

  // Dark-mode aware card background for submissions table
  const rowBg = isDark ? '#1e293b' : 'white'
  const mutedText = isDark ? '#94a3b8' : '#6b7280'

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3500)
  }

  const handleImportOffline = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !exam) return
    // Reset so the same file can be re-selected if needed.
    e.target.value = ''
    setImportingOffline(true)
    try {
      const raw = await file.text()
      // The file content is a base64 string wrapped in btoa(), so it IS the base64 data.
      const imported = await importOfflineAuto(raw.trim())
      // Only add to the current list if it belongs to the exam we're viewing.
      if (exam && imported.exam_id === exam.id) {
        setSubmissions(prev => [imported, ...prev])
      }
      showToast(`Imported: ${imported.student_name} (${imported.student_email})`, 'success')
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Import failed — the file may be invalid or tampered.'
      showToast(msg, 'error')
    } finally {
      setImportingOffline(false)
    }
  }

  const handleExportAll = async () => {
    if (!exam) return
    setExporting(true)
    try {
      const blob = await exportAllSubmissions(exam.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${exam.title}_submissions.examdata`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      showToast(`Exported ${submissions.length} submission(s)`, 'success')
    } catch {
      showToast('Failed to export submissions.', 'error')
    } finally {
      setExporting(false)
    }
  }

  const handleBulkImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !exam) return
    e.target.value = ''
    setBulkImporting(true)
    try {
      const raw = await file.text()
      const payload = JSON.parse(raw)
      const result = await importAllSubmissions(exam.id, payload)
      showToast(result.message, 'success')
      // Reload submissions list.
      getSubmissions(exam.id).then(setSubmissions).catch(() => {})
      setSubPage(1)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Import failed — the file may be invalid or tampered.'
      showToast(msg, 'error')
    } finally {
      setBulkImporting(false)
    }
  }

  const reload = () => {
    if (!id) return
    getExam(Number(id)).then(setExam)
    getSubmissions(Number(id)).then(setSubmissions).catch(() => setSubmissions([]))
  }

  useEffect(reload, [id])

  // Check whether the teacher has configured SMTP credentials.
  // Used to enable/disable the Send Report buttons.
  useEffect(() => {
    getMailSettings()
      .then(s => setMailConfigured(s.smtp_email !== '' && s.password_is_set))
      .catch(() => setMailConfigured(false))
  }, [])

  // Live countdown — ticks every second while the exam is active.
  // Automatically stops the exam (server + local state) when time runs out.
  useEffect(() => {
    if (!exam?.is_active || !exam.started_at || !exam.duration_minutes) {
      setTimeLeft(null)
      return
    }
    // Total window = buffer period + exam period. The countdown runs until
    // students can no longer submit, not just until the exam period opens.
    const endMs = new Date(exam.started_at).getTime()
      + (exam.buffer_duration_minutes ?? 0) * 60 * 1000
      + exam.duration_minutes * 60 * 1000
    const compute = () => Math.max(0, Math.floor((endMs - Date.now()) / 1000))
    setTimeLeft(compute())
    const interval = setInterval(() => {
      const remaining = compute()
      setTimeLeft(remaining)
      if (remaining <= 0) {
        clearInterval(interval)
        toggleExamStatus(exam.id, false)
          .then(updated => setExam(prev => prev ? { ...prev, is_active: updated.is_active, started_at: updated.started_at } : prev))
          .catch(() => {})
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [exam?.id, exam?.is_active, exam?.started_at, exam?.duration_minutes, exam?.buffer_duration_minutes])

  const handleAddSet = async () => {
    if (!exam || !newSetTitle.trim()) return
    try {
      await createQuestionSet({
        exam_id: exam.id,
        title: newSetTitle.trim(),
        order: (exam.question_sets?.length ?? 0) + 1,
      })
      setNewSetTitle('')
      reload()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      alert(msg ?? 'Failed to add question set')
    }
  }

  const handleDeleteSet = async (setId: number) => {
    if (!confirm('Delete this question set and all its questions?')) return
    await deleteQuestionSet(setId)
    reload()
  }

  const handleToggleStatus = async () => {
    if (!exam) return
    setTogglingStatus(true)
    try {
      const updated = await toggleExamStatus(exam.id, !exam.is_active)
      setExam(prev => prev ? { ...prev, is_active: updated.is_active, started_at: updated.started_at } : prev)
    } catch {
      alert('Failed to update exam status.')
    } finally {
      setTogglingStatus(false)
    }
  }

  const handleSendReport = async (sub: Submission) => {
    setSendingReports(prev => new Set(prev).add(sub.id))
    try {
      // Fetch full submission (with answers) then generate the analysis PDF in the browser.
      let pdfBase64: string | undefined
      if (exam) {
        try {
          const fullSub = await getSubmission(sub.id)
          const blob = await generateStudentPDF(exam, fullSub)
          const buf = await blob.arrayBuffer()
          pdfBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
        } catch {
          // PDF generation failed — backend will fall back to its own basic PDF
        }
      }
      const updated = await sendReport(sub.id, pdfBase64)
      setSubmissions(prev => prev.map(s => s.id === updated.id ? updated : s))
      showToast(`Report sent to ${sub.student_email}`, 'success')
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Failed to send report. Check your mail settings.'
      showToast(msg, 'error')
    } finally {
      setSendingReports(prev => { const s = new Set(prev); s.delete(sub.id); return s })
    }
  }

  const handleSendAllReports = async () => {
    if (!id) return
    setBulkSending(true)
    try {
      const res = await sendAllReports(Number(id))
      if (res.queued === 0) {
        showToast('No pending reports — all graded submissions have already been notified.', 'success')
      } else {
        showToast(res.message, 'success')
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Failed to queue reports. Check your mail settings.'
      showToast(msg, 'error')
    } finally {
      setBulkSending(false)
    }
  }

  const handleDeleteSubmission = async () => {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      await deleteSubmission(confirmDelete.id)
      // Remove from local state immediately — no page reload needed.
      setSubmissions(prev => {
        const next = prev.filter(s => s.id !== confirmDelete.id)
        const maxPage = Math.max(1, Math.ceil(next.length / SUB_PER_PAGE))
        setSubPage(p => Math.min(p, maxPage))
        return next
      })
      showToast('Submission deleted successfully.', 'success')
    } catch {
      showToast('Failed to delete submission. Please try again.', 'error')
    } finally {
      setDeleting(false)
      setConfirmDelete(null)
    }
  }

  const handleDeleteQuestion = async (qId: number) => {
    if (!confirm('Delete this question?')) return
    await deleteQuestion(qId)
    // Optimistic update: remove from local state immediately, no full reload needed.
    setExam(prev => {
      if (!prev) return prev
      return {
        ...prev,
        question_sets: prev.question_sets?.map(qs => ({
          ...qs,
          questions: qs.questions?.filter(q => q.id !== qId),
        })),
      }
    })
  }

  const openDuplicateModal = (setId: number) => {
    const nextLetter = String.fromCharCode(65 + (exam?.question_sets?.length ?? 0))
    setDuplicatingSet({ id: setId, suggestedName: `Set ${nextLetter}` })
  }

  const handleConfirmDuplicate = async (name: string) => {
    if (!duplicatingSet) return
    setDuplicating(true)
    try {
      const newSet = await duplicateQuestionSet(duplicatingSet.id, name)
      setExam(prev => {
        if (!prev) return prev
        return { ...prev, question_sets: [...(prev.question_sets ?? []), newSet] }
      })
      showToast(`"${name}" created with all questions copied.`, 'success')
      setDuplicatingSet(null)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      showToast(msg ?? 'Failed to duplicate question set.', 'error')
    } finally {
      setDuplicating(false)
    }
  }

  const handleSaveEditedQuestion = (updated: Question) => {
    setExam(prev => {
      if (!prev) return prev
      return {
        ...prev,
        question_sets: prev.question_sets?.map(qs => ({
          ...qs,
          questions: qs.questions?.map(q => q.id === updated.id ? updated : q),
        })),
      }
    })
    setEditingQuestion(null)
    showToast('Question updated.', 'success')
  }

  const handleUpload = async (setId: number, file: File) => {
    if (!exam) return
    setUploadStates(prev => ({ ...prev, [setId]: { loading: true } }))
    try {
      const result = await uploadQuestions(exam.id, setId, file)
      setUploadStates(prev => ({ ...prev, [setId]: { loading: false, result } }))
      if (result.inserted > 0) reload()
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string; error?: string } } })
          ?.response?.data?.message ??
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ??
        'Upload failed'
      const rowErrors =
        (err as { response?: { data?: { errors?: UploadResult['errors'] } } })
          ?.response?.data?.errors
      setUploadStates(prev => ({
        ...prev,
        [setId]: { loading: false, result: rowErrors ? { inserted: 0, errors: rowErrors } : undefined, error: rowErrors ? undefined : msg },
      }))
    }
  }

  if (!exam) return <p style={{ padding: 24 }}>Loading…</p>

  const setCount = exam.question_sets?.length ?? 0
  const atSetLimit = setCount >= 5

  // Master full marks = total points of the first question set (sorted by order).
  const sortedSets = [...(exam.question_sets ?? [])].sort((a, b) => a.order - b.order)
  const masterFullMarks = (sortedSets[0]?.questions ?? []).reduce((sum, q) => sum + q.points, 0)

  const tabBtn = (tab: 'questions' | 'submissions' | 'analytics'): CSSProperties => ({
    padding: '8px 20px', background: 'none', border: 'none',
    borderBottom: activeTab === tab ? '2px solid #1a73e8' : '2px solid transparent',
    fontWeight: activeTab === tab ? 700 : 400,
    color: activeTab === tab ? '#1a73e8' : 'var(--text-muted)',
    cursor: 'pointer', fontSize: 14,
  })

  return (
    <div style={{ maxWidth: 900, margin: '32px auto', padding: '0 24px 48px', fontFamily: 'system-ui, sans-serif', color: 'var(--text)' }}>

      {/* ── Confirmation modal ──────────────────────────────────────────── */}
      {confirmDelete && (
        <ConfirmModal
          message={
            <>
              This will permanently delete <strong>{confirmDelete.student_name}</strong>'s
              attempt and all their marks.{' '}
              <strong style={{ color: '#dc2626' }}>This action cannot be undone.</strong>
            </>
          }
          onConfirm={handleDeleteSubmission}
          onCancel={() => setConfirmDelete(null)}
          confirming={deleting}
        />
      )}

      {/* ── Duplicate set modal ─────────────────────────────────────────── */}
      {duplicatingSet && (
        <DuplicateSetModal
          suggestedName={duplicatingSet.suggestedName}
          onConfirm={handleConfirmDuplicate}
          onCancel={() => setDuplicatingSet(null)}
          duplicating={duplicating}
        />
      )}

      {/* ── Edit question modal ─────────────────────────────────────────── */}
      {editingQuestion && !exam.is_active && (
        <EditQuestionModal
          question={editingQuestion}
          onSaved={handleSaveEditedQuestion}
          onCancel={() => setEditingQuestion(null)}
        />
      )}

      {/* ── Toast notification ──────────────────────────────────────────── */}
      {toast && <Toast message={toast.message} type={toast.type} />}
      {/* Header */}
      <div style={{ marginBottom: 8 }}>
        <Link to="/dashboard" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: 13 }}>
          ← Dashboard
        </Link>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 700, color: isDark ? '#f8fafc' : '#111827' }}>{exam.title}</h2>
          {exam.description && <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14 }}>{exam.description}</p>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
          {/* PIN display */}
          {exam.login_code && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px',
              background: isDark ? (exam.is_active ? '#422006' : '#1e293b') : (exam.is_active ? '#fefce8' : '#f9fafb'),
              border: `1px solid ${isDark ? (exam.is_active ? '#854d0e' : '#334155') : (exam.is_active ? '#fde047' : '#e5e7eb')}`,
              borderRadius: 6,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: isDark ? '#fcd34d' : '#78350f', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                PIN
              </span>
              <span style={{ fontFamily: 'monospace', fontSize: 18, fontWeight: 900, letterSpacing: '3px', color: 'var(--text)' }}>
                {exam.login_code}
              </span>
            </div>
          )}

          {/* Exam status indicator + toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
            background: isDark ? (exam.is_active ? '#14532d' : '#450a0a') : (exam.is_active ? '#f0fdf4' : '#fef2f2'),
            border: `1px solid ${isDark ? (exam.is_active ? '#166534' : '#7f1d1d') : (exam.is_active ? '#86efac' : '#fca5a5')}`,
            borderRadius: 6, fontSize: 13, fontWeight: 600,
            color: isDark ? (exam.is_active ? '#86efac' : '#fca5a5') : (exam.is_active ? '#15803d' : '#dc2626'),
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
              background: exam.is_active ? '#22c55e' : '#ef4444',
            }} />
            {exam.is_active ? 'Live' : 'Inactive'}
          </div>
          {/* Live countdown — only shown while exam is active */}
          {exam.is_active && timeLeft !== null && (() => {
            const h = Math.floor(timeLeft / 3600)
            const m = Math.floor((timeLeft % 3600) / 60)
            const s = timeLeft % 60
            const label = h > 0
              ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
              : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
            const urgent = timeLeft <= 300 // red under 5 min
            return (
              <div style={{
                padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 700,
                fontFamily: 'monospace', letterSpacing: '1px',
                background: isDark ? (urgent ? '#450a0a' : '#14532d') : (urgent ? '#fef2f2' : '#f0fdf4'),
                border: `1px solid ${isDark ? (urgent ? '#7f1d1d' : '#166534') : (urgent ? '#fca5a5' : '#86efac')}`,
                color: isDark ? (urgent ? '#fca5a5' : '#86efac') : (urgent ? '#dc2626' : '#15803d'),
              }}>
                ⏱ {label}
              </div>
            )
          })()}
          <button
            onClick={handleToggleStatus}
            disabled={togglingStatus}
            style={{
              ...btn(exam.is_active ? 'danger' : 'primary'),
              background: exam.is_active ? '#dc2626' : '#16a34a',
              color: 'white', opacity: togglingStatus ? 0.6 : 1,
            }}
          >
            {togglingStatus ? '…' : exam.is_active ? 'Stop Exam' : 'Start Exam'}
          </button>
          {!exam.is_active ? (
            <Link to={`/exams/${exam.id}/edit`}>
              <button style={{ ...btn('outline') }}>Edit Settings</button>
            </Link>
          ) : (
            <button style={{ ...btn('outline'), opacity: 0.45, cursor: 'not-allowed' }} disabled title="Stop the exam to edit settings">
              Edit Settings
            </button>
          )}
          {exam.camera_proctoring_required && exam.is_active && (
            <Link to={`/exams/${exam.id}/monitor`}>
              <button style={{
                ...btn('primary'),
                background: '#7c3aed',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
                Live Monitor
              </button>
            </Link>
          )}
        </div>
      </div>

      <SecurityBar exam={exam} />

      {/* Tabs */}
      <div style={{ borderBottom: '1px solid var(--border)', marginBottom: 24 }}>
        <button style={tabBtn('questions')} onClick={() => setActiveTab('questions')}>
          Questions ({exam.question_sets?.flatMap(qs => qs.questions ?? []).length ?? 0})
        </button>
        <button style={tabBtn('submissions')} onClick={() => setActiveTab('submissions')}>
          Submissions ({submissions.length})
        </button>
        <button style={tabBtn('analytics')} onClick={() => setActiveTab('analytics')}>
          📊 Analytics
        </button>
      </div>

      {/* ── Questions tab ─────────────────────────────────────────────────── */}
      {activeTab === 'questions' && (
        <div>
          {/* Full marks display */}
          {masterFullMarks > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
              padding: '10px 16px', background: 'var(--card-bg2)', borderRadius: 8,
              border: '1px solid var(--border)',
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Exam Full Marks:</span>
              <span style={{ fontSize: 22, fontWeight: 800, color: '#1a73e8', lineHeight: 1 }}>{masterFullMarks}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                (based on {sortedSets[0]?.title ?? 'first set'})
              </span>
            </div>
          )}

          {/* Add Question Set */}
          {exam.is_active && (
            <div style={{
              marginBottom: 16, padding: '10px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600,
              background: isDark ? '#422006' : '#fffbeb',
              border: `1px solid ${isDark ? '#854d0e' : '#fde68a'}`,
              color: isDark ? '#fbbf24' : '#92400e',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ fontSize: 16 }}>🔒</span>
              Editing is locked while the exam is active. Stop the exam to make changes.
            </div>
          )}
          {!exam.is_active && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
              <input
                placeholder="Enter new question set title…"
                value={newSetTitle}
                onChange={e => setNewSetTitle(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddSet()}
                disabled={atSetLimit}
                style={{ ...inputStyle, flex: 1, opacity: atSetLimit ? 0.5 : 1 }}
              />
              <button
                onClick={handleAddSet}
                disabled={atSetLimit || !newSetTitle.trim()}
                style={btn(atSetLimit ? 'ghost' : 'primary')}
              >
                + Add Set
              </button>
            </div>
          )}
          {atSetLimit && (
            <p style={{ color: '#92400e', background: '#fef3c7', padding: '8px 12px', borderRadius: 6, fontSize: 13, marginBottom: 16 }}>
              Maximum of 5 question sets reached.
            </p>
          )}

          {(exam.question_sets ?? []).length === 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No question sets yet. Add one above.</p>
          )}

          {(exam.question_sets ?? []).length > 1 && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                onClick={() => {
                  const allIds = exam.question_sets?.map(qs => qs.id) ?? []
                  const allCollapsed = allIds.every(id => collapsedSets.has(id))
                  setCollapsedSets(allCollapsed ? new Set() : new Set(allIds))
                }}
                style={{ ...btn(), fontSize: 12, padding: '4px 10px' }}
              >
                {(exam.question_sets?.every(qs => collapsedSets.has(qs.id))) ? 'Expand All' : 'Collapse All'}
              </button>
            </div>
          )}

          {exam.question_sets?.map(qs => {
            const isCollapsed = collapsedSets.has(qs.id)
            const qCount = qs.questions?.length ?? 0
            const setTotal = (qs.questions ?? []).reduce((sum, q) => sum + q.points, 0)
            const toggleCollapse = () => setCollapsedSets(prev => {
              const next = new Set(prev)
              if (next.has(qs.id)) next.delete(qs.id); else next.add(qs.id)
              return next
            })

            return (
            <div key={qs.id} style={{ ...card, marginBottom: 20 }}>
              {/* Set header — always visible */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isCollapsed ? 0 : 12 }}>
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1, minWidth: 0 }}
                  onClick={toggleCollapse}
                >
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 20, height: 20, fontSize: 12, color: 'var(--text-muted)',
                    transition: 'transform 0.15s',
                    transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                  }}>
                    ▼
                  </span>
                  <strong style={{ fontSize: 15, color: isDark ? '#f1f5f9' : '#111827' }}>{qs.title}</strong>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {qCount} question{qCount !== 1 ? 's' : ''}
                    {qCount > 0 && <> &middot; {setTotal} marks</>}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
                  {!isCollapsed && !exam.is_active && (
                    <>
                      <button
                        onClick={() => setAddingSetTo(addingSetTo === qs.id ? null : qs.id)}
                        style={btn('primary')}
                      >
                        {addingSetTo === qs.id ? 'Cancel' : '+ Question'}
                      </button>
                      <button
                        onClick={() => fileInputRefs.current[qs.id]?.click()}
                        disabled={uploadStates[qs.id]?.loading}
                        style={btn('outline')}
                        title="Upload questions from a CSV file"
                      >
                        {uploadStates[qs.id]?.loading ? 'Uploading…' : '↑ Upload CSV'}
                      </button>
                    </>
                  )}
                  {!isCollapsed && (
                    <>
                      <button onClick={downloadTemplate} style={btn()} title="Download a filled example CSV">
                        ↓ Template
                      </button>
                      <button
                        onClick={() => exportSetAsCSV(qs)}
                        disabled={qCount === 0}
                        style={{
                          padding: '5px 12px', borderRadius: 5, fontSize: 13, fontWeight: 500,
                          cursor: qCount === 0 ? 'not-allowed' : 'pointer',
                          border: '1px solid var(--border)',
                          background: 'var(--card-bg)',
                          color: 'var(--text)',
                          opacity: qCount === 0 ? 0.45 : 1,
                        }}
                        title="Download questions in this set as CSV"
                      >
                        ↓ Export CSV
                      </button>
                    </>
                  )}
                  {/* Hidden file input */}
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    style={{ display: 'none' }}
                    ref={el => { fileInputRefs.current[qs.id] = el }}
                    onChange={e => {
                      const file = e.target.files?.[0]
                      if (file) handleUpload(qs.id, file)
                      e.target.value = ''
                    }}
                  />
                  {!isCollapsed && !exam.is_active && (
                    <>
                      <button
                        onClick={() => openDuplicateModal(qs.id)}
                        disabled={atSetLimit}
                        style={{ ...btn('outline'), opacity: atSetLimit ? 0.5 : 1 }}
                        title={atSetLimit ? 'Maximum 5 sets reached' : 'Duplicate this set with all its questions'}
                      >
                        ⊕ Duplicate
                      </button>
                      <button onClick={() => handleDeleteSet(qs.id)} style={btn('danger')}>Delete Set</button>
                    </>
                  )}
                </div>
              </div>

              {/* Collapsible content */}
              {!isCollapsed && (
                <>
                  {qCount === 0 && addingSetTo !== qs.id && (
                    <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '4px 0 8px' }}>No questions yet.</p>
                  )}

                  {qs.questions?.map((q, idx) => (
                    <QuestionRow
                      key={q.id}
                      q={q}
                      idx={idx}
                      onDelete={() => handleDeleteQuestion(q.id)}
                      onEdit={() => setEditingQuestion(q)}
                      locked={exam.is_active}
                    />
                  ))}

                  {/* Live marks counter */}
                  {qCount > 0 && (() => {
                    const isNotFirst = sortedSets[0]?.id !== qs.id
                    const mismatch = isNotFirst && masterFullMarks > 0 && setTotal !== masterFullMarks
                    return (
                      <div style={{
                        marginTop: 8, padding: '6px 12px', borderRadius: 6, fontSize: 12,
                        background: mismatch ? '#fef3c7' : 'var(--card-bg2)',
                        border: `1px solid ${mismatch ? '#fde68a' : 'var(--border)'}`,
                        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                      }}>
                        <span style={{ color: 'var(--text)' }}>
                          Set Total: <strong>{setTotal}</strong>
                          {masterFullMarks > 0 && <span style={{ color: 'var(--text-muted)' }}> / {masterFullMarks} marks</span>}
                        </span>
                        {mismatch && (
                          <span style={{ color: '#dc2626', fontWeight: 600 }}>
                            ⚠ Set total ({setTotal}) does not match the required Full Marks ({masterFullMarks}).
                          </span>
                        )}
                      </div>
                    )
                  })()}

                  {/* CSV upload feedback */}
                  {uploadStates[qs.id] && !uploadStates[qs.id].loading && (() => {
                    const st = uploadStates[qs.id]
                    if (st.error) return (
                      <div style={{ margin: '8px 0', padding: '10px 12px', background: '#fee2e2', borderRadius: 6, fontSize: 13, color: '#dc2626' }}>
                        ⚠ {st.error}
                      </div>
                    )
                    const res = st.result
                    if (!res) return null
                    return (
                      <div style={{ margin: '8px 0', padding: '10px 12px', background: res.inserted > 0 ? '#dcfce7' : '#fef3c7', borderRadius: 6, fontSize: 13 }}>
                        {res.inserted > 0 && (
                          <p style={{ margin: '0 0 4px', color: '#15803d', fontWeight: 600 }}>
                            ✓ {res.inserted} question{res.inserted !== 1 ? 's' : ''} imported successfully.
                          </p>
                        )}
                        {res.errors && res.errors.length > 0 && (
                          <div>
                            <p style={{ margin: '0 0 6px', color: '#92400e', fontWeight: 600 }}>
                              Upload rejected — fix {res.errors.length} error{res.errors.length !== 1 ? 's' : ''} and re-upload:
                            </p>
                            <ul style={{ margin: 0, paddingLeft: 18 }}>
                              {res.errors.map((e, i) => (
                                <li key={i} style={{ color: '#78350f', marginBottom: 2 }}>
                                  Row {e.row}: {e.message}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {addingSetTo === qs.id && !exam.is_active && (
                    <AddQuestionForm
                      questionSetId={qs.id}
                      onAdded={() => { setAddingSetTo(null); reload() }}
                      onCancel={() => setAddingSetTo(null)}
                    />
                  )}
                </>
              )}
            </div>
            )
          })}
        </div>
      )}

      {/* ── Submissions tab ────────────────────────────────────────────────── */}
      {activeTab === 'submissions' && (
        <div>
          {/* Hidden file inputs */}
          <input
            ref={offlineInputRef}
            type="file"
            accept=".exambackup"
            style={{ display: 'none' }}
            onChange={handleImportOffline}
          />
          <input
            ref={bulkInputRef}
            type="file"
            accept=".examdata"
            style={{ display: 'none' }}
            onChange={handleBulkImport}
          />

          {/* Toolbar row */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {/* Release All Graded Reports */}
            <button
              onClick={handleSendAllReports}
              disabled={bulkSending || !mailConfigured}
              title={
                !mailConfigured
                  ? 'Please configure your Mail Settings in profile settings to use this feature.'
                  : 'Send performance reports to all graded students who haven\'t been notified yet'
              }
              style={{
                padding: '7px 16px', fontSize: 13, fontWeight: 600,
                background: bulkSending || !mailConfigured ? '#e5e7eb' : '#0f9d58',
                color: bulkSending || !mailConfigured ? '#9ca3af' : 'white',
                border: 'none', borderRadius: 7,
                cursor: bulkSending || !mailConfigured ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              {bulkSending ? '⏳ Sending…' : '📨 Release All Graded Reports'}
            </button>

            {/* AI Grade All Pending */}
            <button
              onClick={async () => {
                if (!id) return
                setAiGradingAll(true)
                try {
                  const result = await autoGradeAllSubmissions(Number(id))
                  setToast({ message: result.message, type: 'success' })
                  const fresh = await getSubmissions(Number(id))
                  setSubmissions(fresh)
                } catch {
                  setToast({ message: 'AI grading failed. Is the LLM service running?', type: 'error' })
                } finally {
                  setAiGradingAll(false)
                }
              }}
              disabled={aiGradingAll || submissions.length === 0}
              title="Use local AI to auto-grade all pending theory and code answers"
              style={{
                padding: '7px 16px', fontSize: 13, fontWeight: 600,
                background: aiGradingAll || submissions.length === 0 ? '#e5e7eb' : '#7c3aed',
                color: aiGradingAll || submissions.length === 0 ? '#9ca3af' : 'white',
                border: 'none', borderRadius: 7,
                cursor: aiGradingAll || submissions.length === 0 ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              {aiGradingAll ? '⏳ AI Grading…' : '🤖 AI Grade All'}
            </button>

            {/* Download All Submissions */}
            <button
              onClick={handleExportAll}
              disabled={exporting || submissions.length === 0}
              title="Download all submissions as a single file for offline grading"
              style={{
                padding: '7px 16px', fontSize: 13, fontWeight: 600,
                background: exporting || submissions.length === 0 ? '#e5e7eb' : '#1a73e8',
                color: exporting || submissions.length === 0 ? '#9ca3af' : 'white',
                border: 'none', borderRadius: 7,
                cursor: exporting || submissions.length === 0 ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              {exporting ? '⏳ Exporting…' : '⬇ Download All'}
            </button>

            {/* Upload All Submissions */}
            <button
              onClick={() => bulkInputRef.current?.click()}
              disabled={bulkImporting}
              title="Upload a previously exported .examdata file to restore submissions"
              style={{
                padding: '7px 16px', fontSize: 13, fontWeight: 600,
                background: bulkImporting ? '#e5e7eb' : '#6d28d9',
                color: bulkImporting ? '#9ca3af' : 'white',
                border: 'none', borderRadius: 7,
                cursor: bulkImporting ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              {bulkImporting ? '⏳ Importing…' : '⬆ Upload Batch'}
            </button>

            <button
              onClick={() => offlineInputRef.current?.click()}
              disabled={importingOffline}
              style={{
                padding: '7px 16px', fontSize: 13, fontWeight: 600,
                background: importingOffline ? '#e5e7eb' : '#1e293b',
                color: importingOffline ? '#9ca3af' : '#93c5fd',
                border: 'none', borderRadius: 7, cursor: importingOffline ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
              title="Upload a student's .exambackup file to record their answers"
            >
              {importingOffline ? '⏳ Importing…' : '⬆ Import Offline'}
            </button>
          </div>

          {submissions.length === 0 && (
            <p style={{ color: mutedText, fontSize: 14 }}>No submissions yet.</p>
          )}
          {submissions.length > 0 && (() => {
            const totalSubPages = Math.ceil(submissions.length / SUB_PER_PAGE)
            const pagedSubmissions = submissions.slice((subPage - 1) * SUB_PER_PAGE, subPage * SUB_PER_PAGE)
            return (<>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ background: isDark ? '#0f172a' : '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                  <th style={{ padding: '10px 12px', textAlign: 'left', color: isDark ? '#cbd5e1' : '#374151' }}>Student</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', color: isDark ? '#cbd5e1' : '#374151' }}>Session</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', color: isDark ? '#cbd5e1' : '#374151' }}>Set</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', color: isDark ? '#cbd5e1' : '#374151' }}>Email</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', color: isDark ? '#cbd5e1' : '#374151' }}>Score</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', color: isDark ? '#cbd5e1' : '#374151' }}>Status</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', color: isDark ? '#cbd5e1' : '#374151' }}>Submitted</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', color: isDark ? '#cbd5e1' : '#374151' }}>Report</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', color: isDark ? '#cbd5e1' : '#374151' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {pagedSubmissions.map(s => (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${isDark ? '#1e293b' : '#f3f4f6'}`, background: rowBg }}>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: isDark ? '#f1f5f9' : '#111827' }}>{s.student_name}</td>
                    <td style={{ padding: '10px 12px' }}>
                      {s.session_id ? (
                        <span style={{
                          fontSize: 11, fontWeight: 700, fontFamily: 'monospace',
                          padding: '2px 8px', borderRadius: 5,
                          background: '#f0fdf4', color: '#15803d',
                        }}>
                          {s.session_id}
                        </span>
                      ) : (
                        <span style={{ color: mutedText, fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      {s.set_name ? (
                        <span style={{
                          fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 5,
                          background: '#ede9fe', color: '#6d28d9',
                        }}>
                          {s.set_name}
                        </span>
                      ) : (
                        <span style={{ color: mutedText, fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', color: mutedText }}>{s.student_email}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 700, color: '#1a73e8' }}>{s.total_score}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 9999,
                        background: s.status === 'graded' ? '#dcfce7' : '#fef3c7',
                        color: s.status === 'graded' ? '#15803d' : '#92400e',
                      }}>
                        {s.status === 'graded' ? 'Graded' : 'Pending'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px', color: mutedText, fontSize: 13 }}>
                      {new Date(s.submitted_at).toLocaleString()}
                    </td>
                    {/* Send Report cell */}
                    <td style={{ padding: '10px 12px' }}>
                      {(() => {
                        const isGraded = s.status === 'graded'
                        const isSending = sendingReports.has(s.id)
                        const disabled = isSending || !mailConfigured || !isGraded
                        const tooltip = !mailConfigured
                          ? 'Please configure your Mail Settings in profile settings to use this feature.'
                          : !isGraded
                          ? 'Only graded submissions can be reported.'
                          : isSending
                          ? 'Sending…'
                          : s.notified_at
                          ? `Resend report (last sent ${new Date(s.notified_at).toLocaleDateString()})`
                          : 'Send performance report to student'
                        return (
                          <button
                            onClick={() => !disabled && handleSendReport(s)}
                            disabled={disabled}
                            title={tooltip}
                            style={{
                              padding: '4px 10px', fontSize: 13, fontWeight: 600,
                              border: 'none', borderRadius: 5,
                              cursor: disabled ? 'not-allowed' : 'pointer',
                              background: disabled ? '#f3f4f6'
                                : s.notified_at ? '#dcfce7'
                                : '#eff6ff',
                              color: disabled ? '#9ca3af'
                                : s.notified_at ? '#15803d'
                                : '#1d4ed8',
                              display: 'flex', alignItems: 'center', gap: 4,
                            }}
                          >
                            {isSending ? '⏳' : s.notified_at ? '✓ Sent' : '📩'}
                          </button>
                        )
                      })()}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <Link to={`/exams/${id}/grade/${s.id}`}>
                          <button style={{
                            padding: '4px 12px', fontSize: 12, fontWeight: 600,
                            background: s.status === 'pending_grading' ? '#1a73e8' : '#f3f4f6',
                            color: s.status === 'pending_grading' ? 'white' : '#374151',
                            border: 'none', borderRadius: 5, cursor: 'pointer',
                          }}>
                            {s.status === 'pending_grading' ? 'Grade' : 'Review'}
                          </button>
                        </Link>
                        <button
                          onClick={() => setConfirmDelete(s)}
                          title="Delete submission"
                          style={{
                            padding: '4px 8px', fontSize: 14, lineHeight: 1,
                            background: '#fee2e2', color: '#dc2626',
                            border: 'none', borderRadius: 5, cursor: 'pointer',
                          }}
                        >
                          🗑
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination controls */}
            {totalSubPages > 1 && (
              <div style={{
                display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6,
                marginTop: 16, flexWrap: 'wrap',
              }}>
                <button
                  onClick={() => setSubPage(p => Math.max(1, p - 1))}
                  disabled={subPage === 1}
                  style={{
                    padding: '6px 12px', fontSize: 13, fontWeight: 600,
                    background: subPage === 1 ? (isDark ? '#1e293b' : '#f3f4f6') : (isDark ? '#334155' : '#e5e7eb'),
                    color: subPage === 1 ? (isDark ? '#475569' : '#9ca3af') : (isDark ? '#e2e8f0' : '#374151'),
                    border: 'none', borderRadius: 6,
                    cursor: subPage === 1 ? 'not-allowed' : 'pointer',
                  }}
                >
                  ← Prev
                </button>
                {Array.from({ length: totalSubPages }, (_, i) => i + 1).map(p => (
                  <button
                    key={p}
                    onClick={() => setSubPage(p)}
                    style={{
                      padding: '6px 11px', fontSize: 13, fontWeight: subPage === p ? 800 : 500,
                      background: subPage === p ? '#1a73e8' : 'transparent',
                      color: subPage === p ? 'white' : (isDark ? '#94a3b8' : '#6b7280'),
                      border: subPage === p ? 'none' : `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
                      borderRadius: 6, cursor: 'pointer', minWidth: 36,
                    }}
                  >
                    {p}
                  </button>
                ))}
                <button
                  onClick={() => setSubPage(p => Math.min(totalSubPages, p + 1))}
                  disabled={subPage === totalSubPages}
                  style={{
                    padding: '6px 12px', fontSize: 13, fontWeight: 600,
                    background: subPage === totalSubPages ? (isDark ? '#1e293b' : '#f3f4f6') : (isDark ? '#334155' : '#e5e7eb'),
                    color: subPage === totalSubPages ? (isDark ? '#475569' : '#9ca3af') : (isDark ? '#e2e8f0' : '#374151'),
                    border: 'none', borderRadius: 6,
                    cursor: subPage === totalSubPages ? 'not-allowed' : 'pointer',
                  }}
                >
                  Next →
                </button>
                <span style={{ fontSize: 12, color: isDark ? '#64748b' : '#9ca3af', marginLeft: 8 }}>
                  {submissions.length} submission{submissions.length !== 1 ? 's' : ''}
                </span>
              </div>
            )}
            </>)
          })()}
        </div>
      )}

      {/* ── Analytics tab ──────────────────────────────────────────────────────── */}
      {activeTab === 'analytics' && exam && (
        <ResultsAnalytics exam={exam} submissions={submissions} examId={id ?? ''} />
      )}
    </div>
  )
}
