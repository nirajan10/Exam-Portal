package routes

import (
	"github.com/exam-platform/backend/handlers"
	"github.com/exam-platform/backend/middleware"
	"github.com/gofiber/fiber/v2"
)

func Setup(app *fiber.App, h *handlers.Handler, jwtSecret string) {
	api := app.Group("/api")

	// ── Public routes ────────────────────────────────────────────────────────
	auth := api.Group("/auth")
	// Register is disabled — accounts are provisioned by a superadmin.
	// Route kept so clients receive a clear 410 Gone instead of 404.
	auth.Post("/register", h.Register)
	auth.Post("/login", h.Login)

	// Students access exam content, submit answers, and run code — no authentication
	api.Get("/exams/active", h.GetActiveExams)             // lobby: list of open exams
	api.Post("/exams/:id/verify-pin", h.VerifyPin)         // PIN verification → access token
	api.Post("/exams/:id/join", h.JoinExam)                // assign session ID + question set
	api.Post("/exams/:id/submit", h.SubmitExam)            // batch answer submission
	api.Get("/exams/:id/public", h.GetPublicExam)
	api.Post("/exams/:id/execute", h.ExecuteForStudent)
	api.Post("/submissions", h.CreateSubmission)           // kept for compatibility

	// ── Teacher-protected routes ──────────────────────────────────────────────
	protected := api.Group("/", middleware.JWTMiddleware(jwtSecret))

	// Exams
	protected.Get("/exams", h.ListExams)
	protected.Post("/exams", h.CreateExam)
	protected.Get("/exams/:id", h.GetExam)
	protected.Put("/exams/:id", h.UpdateExam)
	protected.Patch("/exams/:id/status", h.ToggleExamStatus)
	protected.Delete("/exams/:id", h.DeleteExam)

	// Question sets
	protected.Post("/question-sets", h.CreateQuestionSet)
	protected.Put("/question-sets/:id", h.UpdateQuestionSet)
	protected.Delete("/question-sets/:id", h.DeleteQuestionSet)
	protected.Post("/question-sets/:id/duplicate", h.DuplicateQuestionSet)

	// Questions
	protected.Post("/questions", h.CreateQuestion)
	protected.Put("/questions/:id", h.UpdateQuestion)
	protected.Delete("/questions/:id", h.DeleteQuestion)

	// Password management (requires valid token — used by the force-change flow)
	protected.Post("/auth/update-password", h.UpdatePassword)

	// Teacher profile
	protected.Get("/me", h.GetMe)
	protected.Post("/me/profile-pic", h.UpdateProfilePic)

	// Submissions (teacher reads, grading, deletion)
	protected.Get("/submissions", h.ListSubmissions)
	protected.Get("/submissions/:id", h.GetSubmission)
	protected.Patch("/submissions/:id/grade", h.GradeSubmission)
	protected.Delete("/submissions/:id", h.DeleteSubmission)

	// Analytics
	protected.Get("/exams/:id/analytics", h.GetExamAnalytics)

	// Bulk CSV upload
	protected.Post("/exams/:id/upload-questions", h.UploadQuestions)

	// Offline backup import — exam-scoped (exam id in URL) or auto-detect from file
	protected.Post("/exams/:id/import-offline", h.ImportOfflineSubmission)
	protected.Post("/submissions/import", h.ImportOfflineAuto)

	// Code execution sandbox
	protected.Post("/execute", h.Execute)

	// ── Superadmin-only routes ────────────────────────────────────────────────
	admin := api.Group("/admin",
		middleware.JWTMiddleware(jwtSecret),
		middleware.RequireRole("superadmin"),
	)
	admin.Get("/teachers", h.ListTeachers)
	admin.Post("/create-teacher", h.CreateTeacher)
	admin.Patch("/teachers/:id/reset-password", h.ResetTeacherPassword)
	admin.Patch("/teachers/:id/active", h.SetTeacherActive)
	admin.Delete("/teachers/:id", h.DeleteTeacher)
	admin.Get("/teachers/:id/exams", h.GetTeacherExams)
}
