package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const defaultSessionTTL = 90 * 24 * time.Hour

type Config struct {
	Port           string
	AppEnv         string
	DatabaseURL    string
	AssetRoot      string
	MaxUploadBytes int64
	AllowedOrigin  string
	AuthMode       string
	DevUserEmail   string
	FrontendURL    string
	GoogleClientID string
	GoogleSecret   string
	GoogleRedirect string
	AllowedEmails  []string
	SessionTTL     time.Duration
}

func Load() (Config, error) {
	databaseURL, err := LoadDatabaseURL()
	if err != nil {
		return Config{}, err
	}
	googleClientID, err := getEnvOrFile("AUTH_GOOGLE_CLIENT_ID")
	if err != nil {
		return Config{}, err
	}
	googleSecret, err := getEnvOrFile("AUTH_GOOGLE_CLIENT_SECRET")
	if err != nil {
		return Config{}, err
	}
	allowedOrigin := value("ALLOWED_ORIGIN", "")
	if allowedOrigin == "" {
		allowedOrigin = value("ALLOWED_ORIGINS", "http://localhost:4200")
	}
	cfg := Config{
		Port:           value("PORT", "8080"),
		AppEnv:         value("APP_ENV", "development"),
		DatabaseURL:    databaseURL,
		AssetRoot:      value("ASSET_ROOT", ".local/noted-assets"),
		MaxUploadBytes: 50 << 20,
		AllowedOrigin:  allowedOrigin,
		AuthMode:       value("AUTH_MODE", "development"),
		DevUserEmail:   normalizeEmail(value("DEV_USER_EMAIL", "learner@noted.local")),
		FrontendURL:    value("FRONTEND_URL", "http://localhost:4200"),
		GoogleClientID: googleClientID,
		GoogleSecret:   googleSecret,
		GoogleRedirect: strings.TrimSpace(os.Getenv("AUTH_GOOGLE_REDIRECT_URL")),
		AllowedEmails:  normalizeEmails(parseCSV(os.Getenv("AUTH_GOOGLE_ALLOWED_EMAILS"))),
		SessionTTL:     defaultSessionTTL,
	}
	if raw := os.Getenv("MAX_UPLOAD_BYTES"); raw != "" {
		size, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || size < 1024 {
			return Config{}, fmt.Errorf("MAX_UPLOAD_BYTES must be an integer of at least 1024")
		}
		cfg.MaxUploadBytes = size
	}
	if raw := strings.TrimSpace(os.Getenv("SESSION_TTL")); raw != "" {
		duration, err := time.ParseDuration(raw)
		if err != nil || duration <= 0 {
			return Config{}, errors.New("SESSION_TTL must be a positive duration")
		}
		cfg.SessionTTL = duration
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func LoadDatabaseURL() (string, error) {
	databaseURL, err := getEnvOrFile("DATABASE_URL")
	if err != nil {
		return "", err
	}
	if databaseURL == "" {
		databaseURL = "postgres://noted:noted@localhost:5434/noted?sslmode=disable"
	}
	return databaseURL, nil
}

func (c Config) Validate() error {
	if c.DatabaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	if c.AppEnv != "development" && c.AppEnv != "test" && c.AppEnv != "production" {
		return fmt.Errorf("unsupported APP_ENV %q", c.AppEnv)
	}
	if c.AuthMode == "development" {
		if c.AppEnv == "production" {
			return errors.New("development authentication is forbidden in production")
		}
		if c.DevUserEmail == "" || !strings.Contains(c.DevUserEmail, "@") {
			return errors.New("DEV_USER_EMAIL must be a valid email address")
		}
		return nil
	}
	if c.AuthMode != "google" {
		return fmt.Errorf("unsupported AUTH_MODE %q", c.AuthMode)
	}
	if c.GoogleClientID == "" || c.GoogleSecret == "" || c.GoogleRedirect == "" ||
		len(c.AllowedEmails) == 0 {
		return errors.New("google authentication requires client ID, secret, redirect URL, and allowed emails")
	}
	if err := validateAbsoluteURL("AUTH_GOOGLE_REDIRECT_URL", c.GoogleRedirect, c.AppEnv == "production"); err != nil {
		return err
	}
	if err := validateAbsoluteURL("FRONTEND_URL", c.FrontendURL, c.AppEnv == "production"); err != nil {
		return err
	}
	for _, email := range c.AllowedEmails {
		if !strings.Contains(email, "@") || strings.ContainsAny(email, "\r\n") {
			return fmt.Errorf("AUTH_GOOGLE_ALLOWED_EMAILS contains invalid email %q", email)
		}
	}
	return nil
}

func getEnvOrFile(name string) (string, error) {
	if value := os.Getenv(name); value != "" {
		return strings.TrimSpace(value), nil
	}
	path := os.Getenv(name + "_FILE")
	if path == "" {
		return "", nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("config: reading %s_FILE (%s): %w", name, path, err)
	}
	value := strings.TrimSpace(string(data))
	if value == "" {
		return "", fmt.Errorf("config: %s_FILE (%s) is empty", name, path)
	}
	return value, nil
}

func value(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func parseCSV(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.Split(value, ",")
}

func normalizeEmails(values []string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		email := normalizeEmail(value)
		if email == "" {
			continue
		}
		if _, exists := seen[email]; exists {
			continue
		}
		seen[email] = struct{}{}
		result = append(result, email)
	}
	return result
}

func normalizeEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func validateAbsoluteURL(name, value string, requireHTTPS bool) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return fmt.Errorf("%s must be an absolute URL", name)
	}
	if requireHTTPS && parsed.Scheme != "https" {
		return fmt.Errorf("%s must use HTTPS in production", name)
	}
	return nil
}
