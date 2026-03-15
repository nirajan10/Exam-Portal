package models

import "time"

type TeacherRole string

const (
	RoleSuperAdmin TeacherRole = "superadmin"
	RoleTeacher    TeacherRole = "teacher"
)

type Teacher struct {
	ID                 uint        `gorm:"primaryKey"                                  json:"id"`
	Name               string      `gorm:"not null"                                    json:"name"`
	Email              string      `gorm:"uniqueIndex;not null"                        json:"email"`
	HashedPassword     string      `gorm:"not null"                                    json:"-"`
	ProfilePic         string      `gorm:"default:''"                                  json:"profile_pic"`
	Role               TeacherRole `gorm:"type:varchar(20);not null;default:'teacher'" json:"role"`
	IsActive           bool        `gorm:"not null;default:true"                       json:"is_active"`
	MustChangePassword bool        `gorm:"not null;default:false"                      json:"must_change_password"`
	CreatedAt          time.Time   `                                                   json:"created_at"`
}
