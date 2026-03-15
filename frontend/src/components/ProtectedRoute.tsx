import { type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { getAccessToken, getTeacher } from '../api/client'

/**
 * Wraps teacher-only routes. Redirects to /login when no token is present.
 * If must_change_password is true, redirects to /force-password-change
 * until the teacher sets a permanent password.
 */
export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const location = useLocation()

  if (!getAccessToken()) {
    return <Navigate to="/login" replace />
  }

  const teacher = getTeacher()
  if (
    teacher?.must_change_password &&
    location.pathname !== '/force-password-change'
  ) {
    return <Navigate to="/force-password-change" replace />
  }

  return <>{children}</>
}

/**
 * Wraps superadmin-only routes. Requires both a valid token AND the
 * superadmin role. Teachers who try to access admin pages are redirected
 * to /dashboard instead of /login.
 */
export function AdminRoute({ children }: { children: ReactNode }) {
  const location = useLocation()

  if (!getAccessToken()) {
    return <Navigate to="/login" replace />
  }

  const teacher = getTeacher()
  if (!teacher || teacher.role !== 'superadmin') {
    return <Navigate to="/dashboard" replace />
  }

  if (
    teacher.must_change_password &&
    location.pathname !== '/force-password-change'
  ) {
    return <Navigate to="/force-password-change" replace />
  }

  return <>{children}</>
}
