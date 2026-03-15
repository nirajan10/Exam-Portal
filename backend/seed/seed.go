package seed

import (
	"log"
	"os"

	"github.com/exam-platform/backend/models"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// EnsureSuperAdmin checks whether a superadmin exists and creates one using
// ADMIN_EMAIL / ADMIN_PASSWORD from the environment if not.
// Safe to call on every startup — it is a no-op when an admin already exists.
func EnsureSuperAdmin(db *gorm.DB) {
	email := os.Getenv("ADMIN_EMAIL")
	password := os.Getenv("ADMIN_PASSWORD")

	if email == "" || password == "" {
		log.Println("seed: ADMIN_EMAIL or ADMIN_PASSWORD not set — skipping superadmin bootstrap")
		return
	}

	var count int64
	db.Model(&models.Teacher{}).Where("role = ?", models.RoleSuperAdmin).Count(&count)
	if count > 0 {
		log.Println("seed: superadmin already exists — skipping bootstrap")
		return
	}

	hashed, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		log.Printf("seed: failed to hash admin password: %v", err)
		return
	}

	admin := models.Teacher{
		Name:           "Super Admin",
		Email:          email,
		HashedPassword: string(hashed),
		Role:           models.RoleSuperAdmin,
		IsActive:       true,
	}
	if err := db.Create(&admin).Error; err != nil {
		log.Printf("seed: failed to create superadmin: %v", err)
		return
	}
	log.Printf("seed: superadmin created — email: %s", email)
}
