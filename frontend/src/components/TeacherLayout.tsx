import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Navbar from './Navbar'
import FeedbackModal from './FeedbackModal'
import { getTeacher } from '../api/client'

/**
 * Shared layout for all teacher-authenticated pages.
 * Renders the sticky Navbar at the top, then the page content via <Outlet />.
 * Wrapped by ProtectedRoute in App.tsx so it only mounts when logged in.
 * Background is driven by var(--page-bg) set on <html data-theme> by ThemeContext.
 */
export default function TeacherLayout() {
  const [showFeedback, setShowFeedback] = useState(false)
  const teacher = getTeacher()
  const isTeacher = teacher?.role !== 'superadmin'

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--page-bg)',
      transition: 'background 0.2s',
    }}>
      <Navbar />
      <Outlet />

      {/* Floating feedback button — teachers only (admin has the feedback page) */}
      {isTeacher && (
        <button
          onClick={() => setShowFeedback(true)}
          title="Send Feedback"
          style={{
            position: 'fixed',
            bottom: 28,
            right: 28,
            zIndex: 190,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 20px',
            background: '#1a73e8',
            color: 'white',
            border: 'none',
            borderRadius: 50,
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(26,115,232,0.4)',
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.transform = 'scale(1.05)'
            e.currentTarget.style.boxShadow = '0 6px 24px rgba(26,115,232,0.5)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.transform = 'scale(1)'
            e.currentTarget.style.boxShadow = '0 4px 16px rgba(26,115,232,0.4)'
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Feedback
        </button>
      )}

      {showFeedback && (
        <FeedbackModal onClose={() => setShowFeedback(false)} />
      )}
    </div>
  )
}
