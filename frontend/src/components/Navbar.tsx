import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { Teacher, getTeacher, logout } from '../api/client'
import ProfileModal from './ProfileModal'
import { useTheme } from '../contexts/ThemeContext'

// ── Avatar helpers ─────────────────────────────────────────────────────────────

function getInitials(name: string) {
  return name.split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

/** Deterministic colour derived from the teacher's name — stable across sessions. */
function nameToColor(name: string) {
  const palette = ['#1a73e8', '#0f9d58', '#f4511e', '#9c27b0', '#00acc1', '#e91e63', '#795548', '#fb8c00']
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffffffff
  return palette[Math.abs(h) % palette.length]
}

// ── Avatar ─────────────────────────────────────────────────────────────────────

function Avatar({ teacher, size = 36 }: { teacher: Teacher; size?: number }) {
  const style: CSSProperties = {
    width: size, height: size, borderRadius: '50%',
    flexShrink: 0, overflow: 'hidden',
    border: '2px solid rgba(255,255,255,0.3)',
  }

  if (teacher.profile_pic) {
    return (
      <img
        src={teacher.profile_pic}
        alt={teacher.name}
        style={{ ...style, objectFit: 'cover' }}
      />
    )
  }

  return (
    <div style={{
      ...style,
      background: nameToColor(teacher.name),
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 700, color: 'white', letterSpacing: '0.5px',
    }}>
      {getInitials(teacher.name)}
    </div>
  )
}

// ── Navbar ─────────────────────────────────────────────────────────────────────

export default function Navbar() {
  // Keep a local copy so profile updates trigger a re-render.
  const [teacher, setTeacherState] = useState<Teacher | null>(getTeacher)
  const [open, setOpen] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const { isDark, toggleTheme } = useTheme()

  // Close the dropdown when the user clicks anywhere outside it.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleProfileUpdated = (updated: Teacher) => {
    setTeacherState(updated) // re-render Navbar with new pic
  }

  const displayName = teacher?.name ?? 'Teacher'

  return (
    <>
      <nav style={{
        position: 'sticky', top: 0, zIndex: 200,
        height: 56, padding: '0 24px',
        background: '#1e293b',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      }}>

        {/* ── Left: brand + role-aware nav links ───────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <Link
            to={teacher?.role === 'superadmin' ? '/admin/manage-staff' : '/dashboard'}
            style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <span style={{ fontSize: 20, fontWeight: 800, color: 'white', letterSpacing: '-0.5px' }}>
              Exam Portal
            </span>
          </Link>

          {/* Role-aware navigation links */}
          {teacher?.role === 'superadmin' ? (
            <>
              <NavLink to="/admin/manage-staff" label="Staff Management" />
            </>
          ) : (
            <>
              <NavLink to="/dashboard" label="My Exams" />
            </>
          )}
        </div>

        {/* ── Right: theme toggle + avatar dropdown ─────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={toggleTheme}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 20, padding: '5px 12px',
            cursor: 'pointer', fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.85)',
            transition: 'background 0.15s',
          }}
        >
          <span>{isDark ? '☀️' : '🌙'}</span>
          {isDark ? 'Light' : 'Dark'}
        </button>
        <div ref={dropdownRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setOpen(v => !v)}
            aria-expanded={open}
            aria-haspopup="true"
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: open ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 8, padding: '5px 10px 5px 6px',
              cursor: 'pointer', transition: 'background 0.15s',
            }}
          >
            {teacher && <Avatar teacher={teacher} />}
            <span style={{ fontSize: 14, fontWeight: 500, color: 'white', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayName}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, marginLeft: 2 }}>
              {open ? '▲' : '▼'}
            </span>
          </button>

          {/* ── Dropdown menu ─────────────────────────────────────────────── */}
          {open && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 8px)', right: 0,
              background: 'white', borderRadius: 10,
              border: '1px solid #e5e7eb',
              boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
              minWidth: 200, overflow: 'hidden',
              zIndex: 300,
            }}>
              {/* Teacher info header */}
              <div style={{ padding: '12px 16px', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>
                    {displayName}
                  </div>
                  {teacher?.role === 'superadmin' && (
                    <span style={{
                      fontSize: 9, fontWeight: 800, letterSpacing: '0.5px',
                      background: '#7c3aed', color: 'white',
                      padding: '1px 6px', borderRadius: 9999,
                      textTransform: 'uppercase',
                    }}>
                      Admin
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {teacher?.email}
                </div>
              </div>

              {/* Menu items */}
              <div style={{ padding: '4px 0' }}>
                <MenuItem
                  icon="👤"
                  label="Profile Settings"
                  onClick={() => { setShowProfile(true); setOpen(false) }}
                />
                <MenuItem
                  icon="🔒"
                  label="Account Security"
                  onClick={() => setOpen(false)}
                  dimmed
                />
              </div>

              <div style={{ borderTop: '1px solid #f3f4f6', padding: '4px 0' }}>
                <MenuItem
                  icon="↩"
                  label="Logout"
                  onClick={logout}
                  danger
                />
              </div>
            </div>
          )}
        </div>
        </div>{/* close right flex wrapper */}
      </nav>

      {showProfile && teacher && (
        <ProfileModal
          teacher={teacher}
          onUpdated={handleProfileUpdated}
          onClose={() => setShowProfile(false)}
        />
      )}
    </>
  )
}

// ── NavLink helper (horizontal nav item in the top bar) ────────────────────────

function NavLink({ to, label }: { to: string; label: string }) {
  const active = window.location.pathname.startsWith(to)
  return (
    <Link
      to={to}
      style={{
        textDecoration: 'none', fontSize: 14, fontWeight: 500,
        color: active ? 'white' : 'rgba(255,255,255,0.65)',
        padding: '4px 2px',
        borderBottom: active ? '2px solid white' : '2px solid transparent',
        transition: 'color 0.15s',
      }}
    >
      {label}
    </Link>
  )
}

// ── MenuItem helper ────────────────────────────────────────────────────────────

function MenuItem({
  icon, label, onClick, danger = false, dimmed = false,
}: {
  icon: string
  label: string
  onClick: () => void
  danger?: boolean
  dimmed?: boolean
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', padding: '9px 16px',
        background: hovered ? (danger ? '#fef2f2' : '#f9fafb') : 'transparent',
        border: 'none', cursor: dimmed ? 'default' : 'pointer',
        textAlign: 'left',
        color: danger ? '#dc2626' : dimmed ? '#9ca3af' : '#374151',
        fontSize: 14, fontWeight: 500,
        transition: 'background 0.1s',
      }}
    >
      <span style={{ fontSize: 15, width: 18, textAlign: 'center' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {dimmed && (
        <span style={{ fontSize: 10, background: '#f3f4f6', color: '#9ca3af', padding: '1px 6px', borderRadius: 9999, fontWeight: 600 }}>
          soon
        </span>
      )}
    </button>
  )
}
