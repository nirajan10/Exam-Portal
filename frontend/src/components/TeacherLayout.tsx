import { Outlet } from 'react-router-dom'
import Navbar from './Navbar'

/**
 * Shared layout for all teacher-authenticated pages.
 * Renders the sticky Navbar at the top, then the page content via <Outlet />.
 * Wrapped by ProtectedRoute in App.tsx so it only mounts when logged in.
 * Background is driven by var(--page-bg) set on <html data-theme> by ThemeContext.
 */
export default function TeacherLayout() {
  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--page-bg)',
      transition: 'background 0.2s',
    }}>
      <Navbar />
      <Outlet />
    </div>
  )
}
