package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

const defaultMaxUploadBytes int64 = 25 << 20

type Config struct {
	AppEnv           string
	Port             string
	LogLevel         string
	DatabaseURL      string
	AssetRoot        string
	MaxUploadBytes   int64
	AuthMode         string
	DevUserEmail     string
	FrontendURL      string
	AllowedOrigins   []string
	GoogleClientID   string
	GoogleSecret     string
	GoogleRedirect   string
	AllowedEmails    []string
	AudiverisCommand string
}

func Load() (Config, error) {
	databaseURL, err := secretValue("DATABASE_URL")
	if err != nil {
		return Config{}, err
	}
	googleClientID, err := secretValue("AUTH_GOOGLE_CLIENT_ID")
	if err != nil {
		return Config{}, err
	}
	googleSecret, err := secretValue("AUTH_GOOGLE_CLIENT_SECRET")
	if err != nil {
		return Config{}, err
	}
	cfg := Config{
		AppEnv:           value("APP_ENV", "development"),
		Port:             value("PORT", "8080"),
		LogLevel:         value("LOG_LEVEL", "info"),
		DatabaseURL:      databaseURL,
		AssetRoot:        value("ASSET_ROOT", ".local/noted-assets"),
		MaxUploadBytes:   defaultMaxUploadBytes,
		AuthMode:         value("AUTH_MODE", "development"),
		DevUserEmail:     strings.ToLower(value("DEV_USER_EMAIL", "learner@noted.local")),
		FrontendURL:      value("FRONTEND_URL", "http://localhost:4200"),
		AllowedOrigins:   split(value("ALLOWED_ORIGINS", "http://localhost:4200")),
		GoogleClientID:   googleClientID,
		GoogleSecret:     googleSecret,
		GoogleRedirect:   os.Getenv("AUTH_GOOGLE_REDIRECT_URL"),
		AllowedEmails:    split(os.Getenv("AUTH_GOOGLE_ALLOWED_EMAILS")),
		AudiverisCommand: strings.TrimSpace(os.Getenv("AUDIVERIS_COMMAND")),
	}

	if cfg.DatabaseURL == "" {
		cfg.DatabaseURL = "postgres://noted:noted@localhost:5434/noted?sslmode=disable"
	}
	if raw := os.Getenv("MAX_UPLOAD_BYTES"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("MAX_UPLOAD_BYTES must be a positive integer")
		}
		cfg.MaxUploadBytes = n
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if c.AppEnv != "development" && c.AppEnv != "test" && c.AppEnv != "production" {
		return fmt.Errorf("unsupported APP_ENV %q", c.AppEnv)
	}
	if c.AuthMode == "development" && c.AppEnv != "development" && c.AppEnv != "test" {
		return errors.New("development authentication is forbidden outside development")
	}
	if c.AuthMode == "google" {
		if c.GoogleClientID == "" || c.GoogleSecret == "" || c.GoogleRedirect == "" || len(c.AllowedEmails) == 0 {
			return errors.New("google authentication requires client ID, secret, redirect URL, and allowed emails")
		}
		return nil
	}
	if c.AuthMode != "development" {
		return fmt.Errorf("unsupported AUTH_MODE %q", c.AuthMode)
	}
	if c.DevUserEmail == "" {
		return errors.New("DEV_USER_EMAIL is required for development authentication")
	}
	return nil
}

func value(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func secretValue(key string) (string, error) {
	if file := os.Getenv(key + "_FILE"); file != "" {
		contents, err := os.ReadFile(file)
		if err != nil {
			return "", fmt.Errorf("read configured %s: %w", key+"_FILE", err)
		}
		secret := strings.TrimSpace(string(contents))
		if secret == "" {
			return "", fmt.Errorf("configured %s is empty", key+"_FILE")
		}
		return secret, nil
	}
	return os.Getenv(key), nil
}

func split(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if item := strings.TrimSpace(part); item != "" {
			out = append(out, item)
		}
	}
	return out
}
