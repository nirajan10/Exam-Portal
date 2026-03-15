package middleware

import (
	"errors"

	jwtware "github.com/gofiber/contrib/jwt"
	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

// JWTMiddleware validates Bearer tokens and stores the parsed token in c.Locals("user").
func JWTMiddleware(secret string) fiber.Handler {
	return jwtware.New(jwtware.Config{
		SigningKey: jwtware.SigningKey{Key: []byte(secret)},
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			return fiber.NewError(fiber.StatusUnauthorized, "invalid or expired token")
		},
	})
}

// ExtractTeacherID pulls the teacher ID from the JWT claims stored by JWTMiddleware.
func ExtractTeacherID(c *fiber.Ctx) (uint, error) {
	token, ok := c.Locals("user").(*jwt.Token)
	if !ok {
		return 0, errors.New("no token in context")
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return 0, errors.New("invalid token claims type")
	}
	sub, ok := claims["sub"].(float64)
	if !ok {
		return 0, errors.New("sub claim missing or wrong type")
	}
	return uint(sub), nil
}

// ExtractRole pulls the role string from the JWT claims.
func ExtractRole(c *fiber.Ctx) (string, error) {
	token, ok := c.Locals("user").(*jwt.Token)
	if !ok {
		return "", errors.New("no token in context")
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return "", errors.New("invalid token claims type")
	}
	role, ok := claims["role"].(string)
	if !ok {
		return "", errors.New("role claim missing or wrong type")
	}
	return role, nil
}

// RequireRole returns a middleware that allows only requests whose JWT encodes
// the given role. Must be placed after JWTMiddleware in the handler chain.
func RequireRole(role string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		actual, err := ExtractRole(c)
		if err != nil || actual != role {
			return fiber.NewError(fiber.StatusForbidden, "insufficient permissions")
		}
		return c.Next()
	}
}
