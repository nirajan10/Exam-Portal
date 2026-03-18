import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  Teacher, uploadProfilePic,
  getMailSettings, saveMailSettings, testMailConnection,
  getLLMSettings, saveLLMSettings,
  type MailSettings, type SaveMailSettingsPayload,
  type LLMSettings, type SaveLLMSettingsPayload,
} from '../api/client'

interface Props {
  teacher: Teacher
  onUpdated: (t: Teacher) => void
  onClose: () => void
}

function getInitials(name: string) {
  return name.split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

function nameToColor(name: string) {
  const palette = ['#1a73e8', '#0f9d58', '#f4511e', '#9c27b0', '#00acc1', '#e91e63', '#795548', '#fb8c00']
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffffffff
  return palette[Math.abs(h) % palette.length]
}

// ── Shared input style ────────────────────────────────────────────────────────

const inputStyle = {
  padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 6,
  fontSize: 14, width: '100%', boxSizing: 'border-box' as const,
  background: '#fff', color: '#111827', outline: 'none',
}

const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 600 as const, color: '#6b7280',
  marginBottom: 5, textTransform: 'uppercase' as const, letterSpacing: '0.05em',
}

// ── Profile tab ───────────────────────────────────────────────────────────────

function ProfileTab({ teacher, onUpdated }: { teacher: Teacher; onUpdated: (t: Teacher) => void }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setUploading(true)
    try {
      const updated = await uploadProfilePic(file)
      onUpdated(updated)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Upload failed. Please try again.')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const initials = getInitials(teacher.name)
  const avatarBg = nameToColor(teacher.name)

  return (
    <>
      {/* Avatar */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 24 }}>
        <div style={{ position: 'relative', marginBottom: 12 }}>
          {teacher.profile_pic ? (
            <img
              src={teacher.profile_pic}
              alt="Profile"
              style={{ width: 88, height: 88, borderRadius: '50%', objectFit: 'cover', border: '3px solid #e5e7eb' }}
            />
          ) : (
            <div style={{
              width: 88, height: 88, borderRadius: '50%',
              background: avatarBg, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 30, fontWeight: 700, color: 'white', letterSpacing: 1,
              border: '3px solid #e5e7eb',
            }}>
              {initials}
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" style={{ display: 'none' }} onChange={handleFile} />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          style={{
            padding: '7px 18px', background: uploading ? '#93c5fd' : '#1a73e8',
            color: 'white', border: 'none', borderRadius: 6,
            fontSize: 13, fontWeight: 600, cursor: uploading ? 'not-allowed' : 'pointer',
          }}
        >
          {uploading ? 'Uploading…' : 'Change Photo'}
        </button>
        {error && <p style={{ margin: '8px 0 0', fontSize: 12, color: '#dc2626', textAlign: 'center' }}>⚠ {error}</p>}
        <p style={{ margin: '6px 0 0', fontSize: 11, color: '#9ca3af' }}>JPEG, PNG, GIF or WebP · max 5 MB</p>
      </div>

      {/* Info */}
      <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 20 }}>
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Name</label>
          <div style={{ padding: '9px 12px', background: '#f9fafb', borderRadius: 6, fontSize: 14, color: '#111827' }}>
            {teacher.name}
          </div>
        </div>
        <div>
          <label style={labelStyle}>Email</label>
          <div style={{ padding: '9px 12px', background: '#f9fafb', borderRadius: 6, fontSize: 14, color: '#111827' }}>
            {teacher.email}
          </div>
        </div>
      </div>
    </>
  )
}

// ── Mail Settings tab ─────────────────────────────────────────────────────────

function MailSettingsTab() {
  const [settings, setSettings] = useState<MailSettings | null>(null)
  const [loading, setLoading] = useState(true)

  const [senderName, setSenderName] = useState('')
  const [smtpEmail, setSmtpEmail] = useState('')
  const [appPassword, setAppPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [testStatus, setTestStatus] = useState<{ ok: boolean; msg: string } | null>(null)

  useEffect(() => {
    setLoading(true)
    getMailSettings()
      .then(s => {
        setSettings(s)
        setSenderName(s.smtp_sender_name)
        setSmtpEmail(s.smtp_email)
      })
      .catch(() => setSettings(null))
      .finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    if (!smtpEmail.trim()) { setSaveStatus({ ok: false, msg: 'SMTP email is required.' }); return }
    setSaving(true)
    setSaveStatus(null)
    try {
      const payload: SaveMailSettingsPayload = {
        smtp_sender_name: senderName.trim(),
        smtp_email: smtpEmail.trim(),
        app_password: appPassword,
      }
      const updated = await saveMailSettings(payload)
      setSettings(updated)
      setAppPassword('') // clear after save
      setSaveStatus({ ok: true, msg: 'Mail settings saved.' })
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setSaveStatus({ ok: false, msg: msg ?? 'Failed to save settings.' })
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestStatus(null)
    try {
      const res = await testMailConnection()
      setTestStatus({ ok: true, msg: `Test email sent to ${res.sent_to}` })
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setTestStatus({ ok: false, msg: msg ?? 'Connection test failed.' })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return <div style={{ padding: '24px 0', textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>Loading…</div>
  }

  const isConfigured = !!(settings?.smtp_email && settings?.password_is_set)

  return (
    <div>
      {/* Setup guide */}
      <div style={{
        background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8,
        padding: '14px 16px', marginBottom: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>ℹ️</span>
          <div>
            <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: '#1e40af' }}>
              How to get your Gmail App Password
            </p>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#1d4ed8', lineHeight: 1.8 }}>
              <li>Enable <strong>2-Step Verification</strong> in your Google Account.</li>
              <li>
                Visit{' '}
                <span style={{ fontFamily: 'monospace', fontSize: 11, background: '#dbeafe', padding: '1px 5px', borderRadius: 3 }}>
                  myaccount.google.com/apppasswords
                </span>
              </li>
              <li>Generate a new app password labelled <strong>"ExamPortal"</strong>.</li>
              <li>Copy the <strong>16-character code</strong> (spaces are ignored).</li>
            </ol>
          </div>
        </div>
      </div>

      {/* Fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={labelStyle}>Sender Name</label>
          <input
            style={inputStyle}
            placeholder="e.g. Ms. Johnson"
            value={senderName}
            onChange={e => setSenderName(e.target.value)}
          />
        </div>
        <div>
          <label style={labelStyle}>Gmail Address</label>
          <input
            style={inputStyle}
            type="email"
            placeholder="you@gmail.com"
            value={smtpEmail}
            onChange={e => setSmtpEmail(e.target.value)}
          />
        </div>
        <div>
          <label style={labelStyle}>
            App Password
            {settings?.password_is_set && (
              <span style={{ marginLeft: 6, fontWeight: 400, color: '#15803d', textTransform: 'none', fontSize: 11 }}>
                ✓ saved
              </span>
            )}
          </label>
          <div style={{ position: 'relative' }}>
            <input
              style={{ ...inputStyle, paddingRight: 44 }}
              type={showPassword ? 'text' : 'password'}
              placeholder={settings?.password_is_set ? 'Enter new password to replace' : 'Paste 16-character app password'}
              value={appPassword}
              onChange={e => setAppPassword(e.target.value)}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword(v => !v)}
              style={{
                position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 14, color: '#9ca3af', padding: 2,
              }}
              title={showPassword ? 'Hide' : 'Show'}
            >
              {showPassword ? '🙈' : '👁️'}
            </button>
          </div>
        </div>
      </div>

      {/* Status messages */}
      {saveStatus && (
        <p style={{ margin: '12px 0 0', fontSize: 13, color: saveStatus.ok ? '#15803d' : '#dc2626' }}>
          {saveStatus.ok ? '✓ ' : '✗ '}{saveStatus.msg}
        </p>
      )}
      {testStatus && (
        <p style={{ margin: '8px 0 0', fontSize: 13, color: testStatus.ok ? '#15803d' : '#dc2626' }}>
          {testStatus.ok ? '✓ ' : '✗ '}{testStatus.msg}
        </p>
      )}

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <button
          onClick={handleTest}
          disabled={testing || !isConfigured}
          title={!isConfigured ? 'Save your settings first, then test the connection.' : ''}
          style={{
            flex: 1, padding: '9px 0', fontSize: 13, fontWeight: 600,
            background: testing || !isConfigured ? '#f3f4f6' : 'white',
            color: testing || !isConfigured ? '#9ca3af' : '#374151',
            border: '1px solid #d1d5db', borderRadius: 6,
            cursor: testing || !isConfigured ? 'not-allowed' : 'pointer',
          }}
        >
          {testing ? '⏳ Testing…' : '🔌 Test Connection'}
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            flex: 1, padding: '9px 0', fontSize: 13, fontWeight: 600,
            background: saving ? '#93c5fd' : '#1a73e8',
            color: 'white', border: 'none', borderRadius: 6,
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}

// ── LLM Settings tab ──────────────────────────────────────────────────────

const GEMINI_MODELS = [
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Free)' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (Free)' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  { value: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite' },
]

function LLMSettingsTab() {
  const [settings, setSettings] = useState<LLMSettings | null>(null)
  const [loading, setLoading] = useState(true)

  const [model, setModel] = useState('gemini-2.5-flash')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)

  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; msg: string } | null>(null)

  useEffect(() => {
    setLoading(true)
    getLLMSettings()
      .then(s => {
        setSettings(s)
        setModel(s.gemini_model || 'gemini-2.5-flash')
      })
      .catch(() => setSettings(null))
      .finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setSaveStatus(null)
    try {
      const payload: SaveLLMSettingsPayload = {
        gemini_model: model,
        api_key: apiKey,
      }
      const updated = await saveLLMSettings(payload)
      setSettings(updated)
      setApiKey('')
      setSaveStatus({ ok: true, msg: 'AI Grading settings saved.' })
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setSaveStatus({ ok: false, msg: msg ?? 'Failed to save settings.' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div style={{ padding: '24px 0', textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>Loading…</div>
  }

  return (
    <div>
      {/* Setup guide */}
      <div style={{
        background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8,
        padding: '14px 16px', marginBottom: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>🤖</span>
          <div>
            <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: '#15803d' }}>
              How to get your Gemini API Key (Free)
            </p>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#166534', lineHeight: 1.8 }}>
              <li>
                Visit{' '}
                <span style={{ fontFamily: 'monospace', fontSize: 11, background: '#dcfce7', padding: '1px 5px', borderRadius: 3 }}>
                  aistudio.google.com/apikey
                </span>
              </li>
              <li>Sign in with your Google account.</li>
              <li>Click <strong>"Create API key"</strong> and select a project (or create one).</li>
              <li>Copy the generated key and paste it below.</li>
            </ol>
            <p style={{ margin: '8px 0 0', fontSize: 11, color: '#166534' }}>
              The free tier includes generous rate limits for Gemini Flash models — no billing required.
            </p>
          </div>
        </div>
      </div>

      {/* Fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={labelStyle}>Model</label>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {GEMINI_MODELS.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <p style={{ margin: '4px 0 0', fontSize: 11, color: '#9ca3af' }}>
            Gemini 2.5 Flash is recommended — fast, accurate, and free.
          </p>
        </div>
        <div>
          <label style={labelStyle}>
            Gemini API Key
            {settings?.api_key_set && (
              <span style={{ marginLeft: 6, fontWeight: 400, color: '#15803d', textTransform: 'none', fontSize: 11 }}>
                ✓ saved
              </span>
            )}
          </label>
          <div style={{ position: 'relative' }}>
            <input
              style={{ ...inputStyle, paddingRight: 44 }}
              type={showKey ? 'text' : 'password'}
              placeholder={settings?.api_key_set ? 'Enter new key to replace' : 'Paste your Gemini API key'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowKey(v => !v)}
              style={{
                position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 14, color: '#9ca3af', padding: 2,
              }}
              title={showKey ? 'Hide' : 'Show'}
            >
              {showKey ? '🙈' : '👁️'}
            </button>
          </div>
        </div>
      </div>

      {/* Status messages */}
      {saveStatus && (
        <p style={{ margin: '12px 0 0', fontSize: 13, color: saveStatus.ok ? '#15803d' : '#dc2626' }}>
          {saveStatus.ok ? '✓ ' : '✗ '}{saveStatus.msg}
        </p>
      )}

      {/* Save button */}
      <div style={{ marginTop: 18 }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            width: '100%', padding: '9px 0', fontSize: 13, fontWeight: 600,
            background: saving ? '#93c5fd' : '#1a73e8',
            color: 'white', border: 'none', borderRadius: 6,
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}

// ── Modal shell ───────────────────────────────────────────────────────────────

export default function ProfileModal({ teacher, onUpdated, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<'profile' | 'mail' | 'llm'>('profile')

  const tabBtn = (tab: 'profile' | 'mail' | 'llm') => ({
    flex: 1, padding: '9px 0', fontSize: 13, fontWeight: 600 as const,
    border: 'none', cursor: 'pointer',
    borderBottom: activeTab === tab ? '2px solid #1a73e8' : '2px solid transparent',
    background: 'transparent',
    color: activeTab === tab ? '#1a73e8' : '#6b7280',
    transition: 'color 0.15s',
  })

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'white', borderRadius: 12, padding: '0',
          width: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          fontFamily: 'system-ui, sans-serif', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px 0' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>Settings</h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af', lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #f3f4f6', margin: '12px 24px 0' }}>
          <button style={tabBtn('profile')} onClick={() => setActiveTab('profile')}>👤 Profile</button>
          <button style={tabBtn('mail')} onClick={() => setActiveTab('mail')}>✉️ Mail</button>
          <button style={tabBtn('llm')} onClick={() => setActiveTab('llm')}>🤖 AI Grading</button>
        </div>

        {/* Tab content */}
        <div style={{ padding: '20px 24px 24px', maxHeight: 480, overflowY: 'auto' }}>
          {activeTab === 'profile' && <ProfileTab teacher={teacher} onUpdated={onUpdated} />}
          {activeTab === 'mail' && <MailSettingsTab />}
          {activeTab === 'llm' && <LLMSettingsTab />}
        </div>

        {/* Close */}
        <div style={{ padding: '0 24px 20px' }}>
          <button
            onClick={onClose}
            style={{
              width: '100%', padding: '9px',
              background: 'white', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 6,
              fontSize: 14, cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
