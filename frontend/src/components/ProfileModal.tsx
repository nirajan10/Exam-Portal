import { useRef, useState, type ChangeEvent } from 'react'
import { Teacher, uploadProfilePic } from '../api/client'

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

export default function ProfileModal({ teacher, onUpdated, onClose }: Props) {
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
    /* Overlay */
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {/* Card — stop click propagation so clicks inside don't close */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'white', borderRadius: 12, padding: '32px 28px',
          width: 360, boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>
            Profile Settings
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af', lineHeight: 1 }}
          >
            ×
          </button>
        </div>

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

          {/* Hidden file input */}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            style={{ display: 'none' }}
            onChange={handleFile}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            style={{
              padding: '7px 18px',
              background: uploading ? '#93c5fd' : '#1a73e8',
              color: 'white', border: 'none', borderRadius: 6,
              fontSize: 13, fontWeight: 600, cursor: uploading ? 'not-allowed' : 'pointer',
            }}
          >
            {uploading ? 'Uploading…' : 'Change Photo'}
          </button>
          {error && (
            <p style={{ margin: '8px 0 0', fontSize: 12, color: '#dc2626', textAlign: 'center' }}>⚠ {error}</p>
          )}
          <p style={{ margin: '6px 0 0', fontSize: 11, color: '#9ca3af' }}>
            JPEG, PNG, GIF or WebP · max 5 MB
          </p>
        </div>

        {/* Info */}
        <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 20 }}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Name
            </label>
            <div style={{ padding: '9px 12px', background: '#f9fafb', borderRadius: 6, fontSize: 14, color: '#111827' }}>
              {teacher.name}
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Email
            </label>
            <div style={{ padding: '9px 12px', background: '#f9fafb', borderRadius: 6, fontSize: 14, color: '#111827' }}>
              {teacher.email}
            </div>
          </div>
        </div>

        {/* Close */}
        <button
          onClick={onClose}
          style={{
            marginTop: 24, width: '100%', padding: '9px',
            background: 'white', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 6,
            fontSize: 14, cursor: 'pointer',
          }}
        >
          Close
        </button>
      </div>
    </div>
  )
}
