import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { updatePassword, getTeacher, setTeacher } from '../api/client'
import { useTheme } from '../contexts/ThemeContext'

export default function ForcePasswordChange() {
  const navigate = useNavigate()
  const { isDark } = useTheme()
  const teacher = getTeacher()

  const [newPassword, setNewPassword]     = useState('')
  const [confirmPassword, setConfirm]     = useState('')
  const [error, setError]                 = useState('')
  const [loading, setLoading]             = useState(false)

  // Warn if the user tries to close/refresh the tab before changing password.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      await updatePassword(newPassword)
      // Clear the flag in the local cache so ProtectedRoute stops redirecting.
      if (teacher) setTeacher({ ...teacher, must_change_password: false })
      navigate(teacher?.role === 'superadmin' ? '/admin/manage-staff' : '/dashboard', { replace: true })
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Failed to update password. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const inputSt = {
    width: '100%', padding: '10px 12px',
    border: `1px solid ${isDark ? '#475569' : '#d1d5db'}`,
    borderRadius: 7, fontSize: 14, boxSizing: 'border-box' as const,
    color: isDark ? '#f1f5f9' : '#111827',
    background: isDark ? '#1e293b' : 'white',
    outline: 'none',
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: isDark ? '#0f172a' : '#f8fafc',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: 24,
    }}>
      <div style={{
        width: '100%', maxWidth: 440,
        background: isDark ? '#1e293b' : 'white',
        borderRadius: 16,
        border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
        boxShadow: '0 8px 32px rgba(0,0,0,0.08)',
        padding: 40,
      }}>
        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 10, marginBottom: 16,
            background: 'linear-gradient(135deg, #f59e0b, #ef4444)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22,
          }}>
            🔑
          </div>
          <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800, color: isDark ? '#f1f5f9' : '#0f172a' }}>
            Set Your Password
          </h2>
          <p style={{ margin: 0, fontSize: 14, color: isDark ? '#94a3b8' : '#64748b' }}>
            Your account has a temporary password. Please set a permanent password to continue.
          </p>
        </div>

        {/* Name badge */}
        {teacher && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px', marginBottom: 24,
            background: isDark ? '#0f172a' : '#f8fafc',
            border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
            borderRadius: 8,
          }}>
            <span style={{ fontSize: 18 }}>👤</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: isDark ? '#f1f5f9' : '#111827' }}>
                {teacher.name}
              </div>
              <div style={{ fontSize: 12, color: isDark ? '#64748b' : '#9ca3af' }}>
                {teacher.email}
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div style={{ marginBottom: 16 }}>
            <label style={{
              display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6,
              color: isDark ? '#cbd5e1' : '#374151',
            }}>
              New Password
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
              required
              autoComplete="new-password"
              style={inputSt}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{
              display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6,
              color: isDark ? '#cbd5e1' : '#374151',
            }}>
              Confirm Password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirm(e.target.value)}
              placeholder="Re-enter new password"
              required
              autoComplete="new-password"
              style={inputSt}
            />
          </div>

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

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '12px 0',
              background: loading ? '#93c5fd' : '#1a73e8',
              color: 'white', border: 'none', borderRadius: 8,
              fontSize: 15, fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Saving…' : 'Set Password & Continue'}
          </button>
        </form>

        <p style={{ margin: '16px 0 0', textAlign: 'center', fontSize: 12, color: isDark ? '#475569' : '#9ca3af' }}>
          You cannot skip this step. Contact your administrator if you have issues.
        </p>
      </div>
    </div>
  )
}
