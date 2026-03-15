import { useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '../contexts/ThemeContext'

// ── Theme tokens ──────────────────────────────────────────────────────────────

const light = {
  bg:         '#f8fafc',
  topbar:     'rgba(248,250,252,0.85)',
  card:       '#ffffff',
  cardBorder: '#e2e8f0',
  cardHover:  '#f1f5f9',
  text:       '#0f172a',
  muted:      '#64748b',
  toggle:     '#e2e8f0',
  toggleText: '#374151',
  footer:     '#94a3b8',
}

const dark = {
  bg:         '#0f172a',
  topbar:     'rgba(15,23,42,0.85)',
  card:       '#1e293b',
  cardBorder: '#334155',
  cardHover:  '#263348',
  text:       '#f1f5f9',
  muted:      '#94a3b8',
  toggle:     '#334155',
  toggleText: '#e2e8f0',
  footer:     '#475569',
}

type Theme = typeof light

// ── Role card ─────────────────────────────────────────────────────────────────

function RoleCard({
  icon, title, description, cta, onClick, accent, t,
}: {
  icon: string
  title: string
  description: string
  cta: string
  onClick: () => void
  accent: string
  t: Theme
}) {
  const [hovered, setHovered] = useState(false)

  const cardStyle: CSSProperties = {
    width: 280,
    padding: '36px 28px',
    background: hovered ? t.cardHover : t.card,
    border: `2px solid ${hovered ? accent : t.cardBorder}`,
    borderRadius: 16,
    cursor: 'pointer',
    textAlign: 'center',
    transition: 'all 0.15s ease',
    boxShadow: hovered
      ? '0 16px 48px rgba(0,0,0,0.14)'
      : '0 2px 8px rgba(0,0,0,0.04)',
    transform: hovered ? 'translateY(-3px)' : 'translateY(0)',
    outline: 'none',
  }

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={cardStyle}
    >
      <div style={{ fontSize: 54, marginBottom: 18, lineHeight: 1 }}>{icon}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: t.text, marginBottom: 10 }}>
        {title}
      </div>
      <div style={{ fontSize: 14, color: t.muted, lineHeight: 1.6, marginBottom: 24 }}>
        {description}
      </div>
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 13, fontWeight: 700, color: accent,
        background: hovered ? `${accent}15` : `${accent}10`,
        padding: '7px 16px', borderRadius: 20,
        transition: 'background 0.15s',
      }}>
        {cta} <span style={{ fontSize: 15 }}>→</span>
      </div>
    </button>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function LandingPage() {
  const navigate = useNavigate()
  const { isDark, toggleTheme } = useTheme()
  const t = isDark ? dark : light

  return (
    <div style={{
      minHeight: '100vh',
      background: t.bg,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      transition: 'background 0.25s, color 0.25s',
    }}>

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        backdropFilter: 'blur(12px)',
        background: t.topbar,
        borderBottom: `1px solid ${t.cardBorder}`,
        padding: '0 32px', height: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{
          fontSize: 18, fontWeight: 800, color: t.text,
          letterSpacing: '-0.5px', display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{
            width: 28, height: 28, borderRadius: 7,
            background: 'linear-gradient(135deg, #1a73e8, #0f9d58)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, color: 'white', fontWeight: 900,
          }}>E</span>
          Exam Portal
        </div>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            background: t.toggle, border: 'none',
            borderRadius: 20, padding: '7px 14px',
            cursor: 'pointer', fontSize: 13, fontWeight: 500, color: t.toggleText,
            transition: 'background 0.15s',
          }}
        >
          <span style={{ fontSize: 15 }}>{isDark ? '☀️' : '🌙'}</span>
          {isDark ? 'Light' : 'Dark'}
        </button>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <main style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        minHeight: 'calc(100vh - 60px)',
        padding: '40px 24px 80px',
        textAlign: 'center',
      }}>

        {/* Badge */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 11, fontWeight: 700, letterSpacing: '1.5px',
          textTransform: 'uppercase', color: '#1a73e8',
          background: '#1a73e810', border: '1px solid #1a73e830',
          borderRadius: 9999, padding: '5px 14px', marginBottom: 24,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#1a73e8', display: 'inline-block' }} />
          Secure Online Examination System
        </div>

        {/* Headline */}
        <h1 style={{
          margin: '0 0 16px',
          fontSize: 'clamp(36px, 6vw, 60px)',
          fontWeight: 900, lineHeight: 1.08,
          color: t.text, letterSpacing: '-1.5px',
        }}>
          Exam Portal
        </h1>

        {/* Tagline */}
        <p style={{
          margin: '0 0 52px',
          fontSize: 'clamp(15px, 2vw, 19px)',
          color: t.muted, maxWidth: 500, lineHeight: 1.6,
        }}>
          Create, deliver, and monitor exams with full proctoring — for teachers and students alike.
        </p>

        {/* ── Role selector ────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', justifyContent: 'center' }}>
          <RoleCard
            icon="🎓"
            title="I'm a Teacher"
            description="Create exams, manage question sets, monitor students in real-time, and review submissions."
            cta="Go to Teacher Portal"
            onClick={() => navigate('/login')}
            accent="#1a73e8"
            t={t}
          />
          <RoleCard
            icon="📝"
            title="I'm a Student"
            description="Enter your exam code to join an active exam session and submit your answers securely."
            cta="Join an Exam"
            onClick={() => navigate('/exams')}
            accent="#0f9d58"
            t={t}
          />
        </div>

        {/* Feature strip */}
        <div style={{
          marginTop: 64,
          display: 'flex', gap: 32, flexWrap: 'wrap', justifyContent: 'center',
        }}>
          {[
            { icon: '🔒', label: 'Fullscreen lockdown' },
            { icon: '📷', label: 'Camera proctoring' },
            { icon: '⚡', label: 'Live code execution' },
            { icon: '📊', label: 'Instant submissions' },
          ].map(f => (
            <div key={f.label} style={{
              display: 'flex', alignItems: 'center', gap: 7,
              fontSize: 13, color: t.footer, fontWeight: 500,
            }}>
              <span>{f.icon}</span>
              {f.label}
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
