import { useState, type FormEvent, type CSSProperties, type ReactNode } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { login } from '../api/client'
import { useTheme } from '../contexts/ThemeContext'

// ── Input helper ──────────────────────────────────────────────────────────────

function Field({ label, isDark, children }: { label: string; isDark: boolean; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{
        display: 'block', fontSize: 13, fontWeight: 600,
        color: isDark ? '#cbd5e1' : '#374151', marginBottom: 6,
      }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function inputStyle(isDark: boolean): CSSProperties {
  return {
    width: '100%', padding: '10px 12px',
    border: `1px solid ${isDark ? '#475569' : '#d1d5db'}`,
    borderRadius: 7, fontSize: 14, boxSizing: 'border-box',
    color: isDark ? '#f1f5f9' : '#111827',
    background: isDark ? '#1e293b' : 'white',
    outline: 'none', transition: 'border-color 0.15s',
  }
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <>
      <style>{`
        @keyframes login-spin { to { transform: rotate(360deg); } }
        .login-spinner {
          display: inline-block; width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.4);
          border-top-color: white; border-radius: 50%;
          animation: login-spin 0.7s linear infinite;
          vertical-align: middle; margin-right: 7px;
        }
      `}</style>
      <span className="login-spinner" />
    </>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Login() {
  const navigate = useNavigate()
  const { isDark, toggleTheme } = useTheme()
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { teacher } = await login(email, password)
      if (teacher.must_change_password) {
        navigate('/force-password-change')
      } else {
        navigate(teacher.role === 'superadmin' ? '/admin/manage-staff' : '/dashboard')
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Invalid email or password.')
    } finally {
      setLoading(false)
    }
  }

  const isLogin = true

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: isDark ? '#0f172a' : '#f8fafc',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: '24px',
      transition: 'background 0.2s',
    }}>
      <div style={{
        width: '100%', maxWidth: 420,
        background: isDark ? '#1e293b' : 'white', borderRadius: 16,
        border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
        boxShadow: '0 8px 32px rgba(0,0,0,0.08)',
        padding: 40,
      }}>

        {/* Back to Home + theme toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
          <Link
            to="/"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              color: isDark ? '#94a3b8' : '#64748b', textDecoration: 'none', fontSize: 13, fontWeight: 500,
            }}
          >
            ← Back to Home
          </Link>
          <button
            onClick={toggleTheme}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: isDark ? '#334155' : '#f1f5f9',
              border: 'none', borderRadius: 20, padding: '5px 12px',
              cursor: 'pointer', fontSize: 12, fontWeight: 500,
              color: isDark ? '#e2e8f0' : '#374151',
            }}
          >
            <span>{isDark ? '☀️' : '🌙'}</span>
            {isDark ? 'Light' : 'Dark'}
          </button>
        </div>

        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 10, marginBottom: 16,
            background: 'linear-gradient(135deg, #1a73e8, #0f9d58)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, color: 'white', fontWeight: 900,
          }}>
            🎓
          </div>
          <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800, color: isDark ? '#f1f5f9' : '#0f172a' }}>
            Sign In
          </h2>
          <p style={{ margin: 0, fontSize: 14, color: isDark ? '#94a3b8' : '#64748b' }}>
            Sign in to manage your exams and students.
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <Field label="Email Address" isDark={isDark}>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@university.edu"
              required
              autoComplete="email"
              style={inputStyle(isDark)}
            />
          </Field>

          <Field label="Password" isDark={isDark}>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={isLogin ? '••••••••' : 'At least 8 characters'}
              required
              minLength={8}
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              style={inputStyle(isDark)}
            />
          </Field>

          {/* Error */}
          {error && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              background: '#fef2f2', border: '1px solid #fca5a5',
              borderRadius: 8, padding: '10px 14px', marginBottom: 16,
            }}>
              <span style={{ color: '#dc2626', flexShrink: 0 }}>⚠</span>
              <p style={{ margin: 0, fontSize: 13, color: '#dc2626' }}>{error}</p>
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '12px 0',
              background: loading ? '#93c5fd' : '#1a73e8',
              color: 'white', border: 'none', borderRadius: 8,
              fontSize: 15, fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s',
            }}
          >
            {loading && <Spinner />}
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p style={{ margin: '20px 0 0', textAlign: 'center', fontSize: 13, color: isDark ? '#475569' : '#9ca3af' }}>
          Account access is provisioned by your administrator.
        </p>
      </div>
    </div>
  )
}
