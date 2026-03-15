package main

import (
	"context"
	"log"

	"github.com/exam-platform/backend/config"
	"github.com/exam-platform/backend/database"
	"github.com/exam-platform/backend/handlers"
	"github.com/exam-platform/backend/routes"
	"github.com/exam-platform/backend/runner"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
)

func main() {
	cfg := config.Load()

	db, err := database.Init(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("database init failed: %v", err)
	}
	log.Println("database connected and schema migrated")

	codeRunner, err := runner.New()
	if err != nil {
		log.Fatalf("docker runner init failed: %v", err)
	}

	// Pre-pull sandbox images so first execution requests are not slow
	codeRunner.WarmUp(context.Background())

	app := fiber.New(fiber.Config{
		// 6 MB body limit — allows profile picture uploads (≤5 MB image + overhead).
		BodyLimit: 6 * 1024 * 1024,
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			code := fiber.StatusInternalServerError
			if e, ok := err.(*fiber.Error); ok {
				code = e.Code
			}
			return c.Status(code).JSON(fiber.Map{"error": err.Error()})
		},
	})

	app.Use(recover.New())
	app.Use(logger.New())
	app.Use(cors.New(cors.Config{
		// In production this is handled by Nginx (same origin). In development
		// the frontend dev server runs on a different port, so CORS is needed.
		AllowOrigins:     "http://localhost,http://localhost:5173,http://localhost:3000",
		AllowHeaders:     "Origin, Content-Type, Accept, Authorization",
		AllowMethods:     "GET,POST,PUT,DELETE,OPTIONS",
		AllowCredentials: true,
	}))

	// Serve uploaded profile pictures as static files.
	app.Static("/uploads", "./uploads")

	h := handlers.New(db, codeRunner, cfg)
	routes.Setup(app, h, cfg.JWTSecret)

	log.Printf("server listening on :%s", cfg.Port)
	log.Fatal(app.Listen(":" + cfg.Port))
}
