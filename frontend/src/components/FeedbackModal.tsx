import { useState, type CSSProperties } from 'react'
import { createFeedback, type FeedbackType } from '../api/client'

const TYPES: { value: FeedbackType; label: string; color: string }[] = [
  { value: 'bug',         label: 'Bug Report',         color: '#ef4444' },
  { value: 'suggestion',  label: 'Feature Suggestion',  color: '#1a73e8' },
  { value: 'usability',   label: 'Usability Issue',     color: '#f59e0b' },
  { value: 'performance', label: 'Performance Issue',    color: '#8b5cf6' },
  { value: 'other',       label: 'Other',                color: '#6b7280' },
]

interface Props {
  onClose: () => void
}

export default function FeedbackModal({ onClose }: Props) {
  const [type, setType] = useState<FeedbackType>('bug')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const handleSubmit = async () => {
    if (!subject.trim() || !body.trim()) {
      setError('Subject and description are required.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await createFeedback({ type, subject: subject.trim(), body: body.trim() })
      setSuccess(true)
      setTimeout(onClose, 1200)
    } catch {
      setError('Failed to submit feedback. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const overlay: CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 10000,
    background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }

  const card: CSSProperties = {
    background: 'white', borderRadius: 14, width: 480, maxWidth: '90vw',
    boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
    overflow: 'hidden',
  }

  const inputStyle: CSSProperties = {
    width: '100%', padding: '10px 12px', border: '1px solid #d1d5db',
    borderRadius: 8, fontSize: 14, outline: 'none',
    boxSizing: 'border-box',
  }

  const btnPrimary: CSSProperties = {
    padding: '10px 24px', background: '#1a73e8', color: 'white',
    border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600,
    cursor: submitting ? 'not-allowed' : 'pointer',
    opacity: submitting ? 0.6 : 1,
  }

  if (success) {
    return (
      <div style={overlay} onClick={onClose}>
        <div style={{ ...card, padding: 40, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>&#10003;</div>
          <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#111827' }}>
            Thank you!
          </h3>
          <p style={{ margin: 0, fontSize: 14, color: '#6b7280' }}>
            Your feedback has been submitted successfully.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #f3f4f6' }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>
            Send Feedback
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#9ca3af' }}>
            Help us improve the platform by sharing your thoughts.
          </p>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Type selector */}
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Type
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {TYPES.map(t => (
                <button
                  key={t.value}
                  onClick={() => setType(t.value)}
                  style={{
                    padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', transition: 'all 0.15s',
                    border: type === t.value ? `2px solid ${t.color}` : '2px solid #e5e7eb',
                    background: type === t.value ? `${t.color}15` : 'white',
                    color: type === t.value ? t.color : '#6b7280',
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Subject */}
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Subject
            </label>
            <input
              type="text"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Brief summary of your feedback"
              style={inputStyle}
              maxLength={255}
            />
          </div>

          {/* Description */}
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Description
            </label>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="Describe the issue or suggestion in detail..."
              rows={5}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          {error && (
            <p style={{ margin: 0, fontSize: 13, color: '#dc2626' }}>{error}</p>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px', borderTop: '1px solid #f3f4f6',
          display: 'flex', justifyContent: 'flex-end', gap: 10,
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '10px 20px', background: '#f3f4f6', color: '#374151',
              border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={submitting} style={btnPrimary}>
            {submitting ? 'Submitting...' : 'Submit Feedback'}
          </button>
        </div>
      </div>
    </div>
  )
}
