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
	SessionTTL       time.Duration
	AudiverisCommand string
	OMRBaseURL       string
	OMRToken         string
}

func Load() (Config, error) {
	databaseURL, err := LoadDatabaseURL()
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
	omrToken, err := secretValue("OMR_TOKEN")
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
		AllowedEmails:    normalizeEmails(split(os.Getenv("AUTH_GOOGLE_ALLOWED_EMAILS"))),
		SessionTTL:       12 * time.Hour,
		AudiverisCommand: strings.TrimSpace(os.Getenv("AUDIVERIS_COMMAND")),
		OMRBaseURL:       strings.TrimRight(strings.TrimSpace(os.Getenv("OMR_BASE_URL")), "/"),
		OMRToken:         omrToken,
	}

	if raw := strings.TrimSpace(os.Getenv("SESSION_TTL")); raw != "" {
		duration, err := time.ParseDuration(raw)
		if err != nil || duration <= 0 {
			return Config{}, errors.New("SESSION_TTL must be a positive duration")
		}
		cfg.SessionTTL = duration
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
	if err := c.validateRecognition(); err != nil {
		return err
	}
	if c.AuthMode == "development" && c.AppEnv != "development" && c.AppEnv != "test" {
		return errors.New("development authentication is forbidden outside development")
	}
	if c.AuthMode == "google" {
		if c.GoogleClientID == "" || c.GoogleSecret == "" || c.GoogleRedirect == "" || len(c.AllowedEmails) == 0 {
			return errors.New("google authentication requires client ID, secret, redirect URL, and allowed emails")
		}
		if c.SessionTTL <= 0 {
			return errors.New("google authentication requires a positive session lifetime")
		}
		if err := validateAbsoluteURL("AUTH_GOOGLE_REDIRECT_URL", c.GoogleRedirect, c.AppEnv == "production"); err != nil {
			return err
		}
		if err := validateAbsoluteURL("FRONTEND_URL", c.FrontendURL, c.AppEnv == "production"); err != nil {
			return err
		}
		for _, email := range c.AllowedEmails {
			if strings.ContainsAny(email, "\r\n") || !strings.Contains(email, "@") {
				return fmt.Errorf("AUTH_GOOGLE_ALLOWED_EMAILS contains invalid email %q", email)
			}
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

func (c Config) validateRecognition() error {
	remoteConfigured := c.OMRBaseURL != "" || c.OMRToken != ""
	if !remoteConfigured {
		return nil
	}
	if c.OMRBaseURL == "" || c.OMRToken == "" {
		return errors.New("OMR_BASE_URL and OMR_TOKEN or OMR_TOKEN_FILE must be configured together")
	}
	if c.AudiverisCommand != "" {
		return errors.New("OMR_BASE_URL and AUDIVERIS_COMMAND cannot both be configured")
	}
	parsed, err := url.Parse(c.OMRBaseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return errors.New("OMR_BASE_URL must be an absolute HTTP(S) URL")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("OMR_BASE_URL must not include credentials, a query, or a fragment")
	}
	if strings.ContainsAny(c.OMRToken, "\r\n") {
		return errors.New("OMR_TOKEN must not contain line breaks")
	}
	return nil
}

// LoadDatabaseURL reads only the database setting so migration jobs do not
// require unrelated runtime authentication secrets.
func LoadDatabaseURL() (string, error) {
	databaseURL, err := secretValue("DATABASE_URL")
	if err != nil {
		return "", err
	}
	if databaseURL == "" {
		if os.Getenv("APP_ENV") == "production" {
			return "", errors.New("DATABASE_URL or DATABASE_URL_FILE is required in production")
		}
		databaseURL = "postgres://noted:noted@localhost:5434/noted?sslmode=disable"
	}
	return databaseURL, nil
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

func normalizeEmails(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		email := strings.ToLower(strings.TrimSpace(value))
		if email == "" {
			continue
		}
		if _, ok := seen[email]; ok {
			continue
		}
		seen[email] = struct{}{}
		out = append(out, email)
	}
	return out
}

func validateAbsoluteURL(name, value string, requireHTTPS bool) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return fmt.Errorf("%s must be an absolute HTTP(S) URL", name)
	}
	if requireHTTPS && parsed.Scheme != "https" {
		return fmt.Errorf("%s must use HTTPS in production", name)
	}
	return nil
}
