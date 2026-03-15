package config

import (
	"log"
	"os"

	"github.com/joho/godotenv"
)

type Config struct {
	DatabaseURL   string
	JWTSecret     string
	Port          string
	// Superadmin bootstrap — both must be set for auto-creation to run.
	AdminEmail    string
	AdminPassword string
}

func Load() *Config {
	// Load .env in development; ignore error in production (env vars set externally)
	_ = godotenv.Load()

	cfg := &Config{
		DatabaseURL:   getRequired("DATABASE_URL"),
		JWTSecret:     getRequired("JWT_SECRET"),
		Port:          getOrDefault("PORT", "8080"),
		AdminEmail:    os.Getenv("ADMIN_EMAIL"),
		AdminPassword: os.Getenv("ADMIN_PASSWORD"),
	}
	return cfg
}

func getRequired(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("required environment variable %s is not set", key)
	}
	return v
}

func getOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
