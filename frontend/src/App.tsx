import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import ProtectedRoute, { AdminRoute } from './components/ProtectedRoute'
import TeacherLayout from './components/TeacherLayout'
import LandingPage from './pages/LandingPage'
import ExamLobby from './pages/ExamLobby'
import StudentJoin from './pages/StudentJoin'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import ExamCreate from './pages/ExamCreate'
import ExamEdit from './pages/ExamEdit'
import ExamView from './pages/ExamView'
import GradingView from './pages/GradingView'
import StudentExam from './pages/StudentExam'
import AdminStaff from './pages/AdminStaff'
import ForcePasswordChange from './pages/ForcePasswordChange'

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>

          {/* ── Root ──────────────────────────────────────────────────────── */}
          <Route path="/" element={<LandingPage />} />

          {/* ── Student flow ──────────────────────────────────────────────── */}
          {/* /exams        — live lobby: browse active exams, enter PIN       */}
          <Route path="/exams" element={<ExamLobby />} />
          {/* /student/join — legacy entry kept for backwards compatibility    */}
          <Route path="/student/join" element={<StudentJoin />} />
          {/* /take/:id     — onboarding form + fullscreen exam session        */}
          <Route path="/take/:id" element={<StudentExam />} />

          {/* ── Teacher auth ──────────────────────────────────────────────── */}
          <Route path="/login" element={<Login />} />

          {/* ── Force password change — protected but outside TeacherLayout ── */}
          <Route
            path="/force-password-change"
            element={
              <ProtectedRoute>
                <ForcePasswordChange />
              </ProtectedRoute>
            }
          />

          {/*
            Teacher routes — all require a valid JWT.
            ProtectedRoute redirects to /login when no token is present.
            TeacherLayout renders the sticky Navbar and <Outlet /> for the page.
          */}
          <Route
            element={
              <ProtectedRoute>
                <TeacherLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/dashboard"                              element={<Dashboard />}    />
            <Route path="/exams/new"                              element={<ExamCreate />}   />
            <Route path="/exams/:id/edit"                         element={<ExamEdit />}     />
            <Route path="/exams/:id"                              element={<ExamView />}     />
            <Route path="/exams/:examId/grade/:submissionId"      element={<GradingView />}  />
          </Route>

          {/* ── Admin routes — superadmin role required ────────────────────── */}
          <Route
            element={
              <AdminRoute>
                <TeacherLayout />
              </AdminRoute>
            }
          >
            <Route path="/admin/manage-staff" element={<AdminStaff />} />
          </Route>

          {/* ── Catch-all — send unknown paths back to the landing page ───── */}
          <Route path="*" element={<Navigate to="/" replace />} />

        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  )
}
