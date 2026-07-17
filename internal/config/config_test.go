package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDevelopmentAuthFailsClosed(t *testing.T) {
	cfg := Config{AppEnv: "production", AuthMode: "development", DevUserEmail: "learner@example.com"}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected production configuration to reject development authentication")
	}
}

func TestGoogleAuthRequiresProductionSettings(t *testing.T) {
	cfg := Config{AppEnv: "production", AuthMode: "google"}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected incomplete google auth configuration to fail")
	}

	cfg.GoogleClientID = "id"
	cfg.GoogleSecret = "secret"
	cfg.GoogleRedirect = "https://example.com/callback"
	cfg.FrontendURL = "https://example.com"
	cfg.AllowedEmails = []string{"learner@example.com"}
	cfg.SessionTTL = 12 * time.Hour
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected complete google auth configuration to pass: %v", err)
	}
}

func TestGoogleAuthRequiresHTTPSInProduction(t *testing.T) {
	cfg := Config{
		AppEnv:         "production",
		AuthMode:       "google",
		GoogleClientID: "id",
		GoogleSecret:   "secret",
		GoogleRedirect: "http://example.com/callback",
		FrontendURL:    "https://example.com",
		AllowedEmails:  []string{"learner@example.com"},
		SessionTTL:     12 * time.Hour,
	}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("expected insecure production redirect to fail, got %v", err)
	}
}

func TestLoadNormalizesAllowedEmailsAndSessionTTL(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_MODE", "google")
	t.Setenv("AUTH_GOOGLE_CLIENT_ID", "id")
	t.Setenv("AUTH_GOOGLE_CLIENT_SECRET", "secret")
	t.Setenv("AUTH_GOOGLE_REDIRECT_URL", "http://localhost:8080/api/auth/google/callback")
	t.Setenv("AUTH_GOOGLE_ALLOWED_EMAILS", " Learner@Example.COM,learner@example.com ")
	t.Setenv("SESSION_TTL", "6h")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.AllowedEmails) != 1 || cfg.AllowedEmails[0] != "learner@example.com" {
		t.Fatalf("allowed emails = %#v", cfg.AllowedEmails)
	}
	if cfg.SessionTTL != 6*time.Hour {
		t.Fatalf("session TTL = %v, want 6h", cfg.SessionTTL)
	}
}

func TestLoadDatabaseURLDoesNotRequireOAuthConfiguration(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("AUTH_MODE", "google")
	t.Setenv("DATABASE_URL", "postgres://migration-only")
	value, err := LoadDatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	if value != "postgres://migration-only" {
		t.Fatalf("database URL = %q", value)
	}
}

func TestLoadDatabaseURLRequiresExplicitProductionValue(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("DATABASE_URL", "")
	t.Setenv("DATABASE_URL_FILE", "")
	_, err := LoadDatabaseURL()
	if err == nil || !strings.Contains(err.Error(), "required in production") {
		t.Fatalf("expected missing production database URL to fail, got %v", err)
	}
}

func TestConfiguredSecretFileFailsClosed(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_MODE", "development")
	t.Setenv("DATABASE_URL", "postgres://plain-value-must-not-be-used")
	t.Setenv("DATABASE_URL_FILE", filepath.Join(t.TempDir(), "missing-secret"))
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL_FILE") {
		t.Fatalf("missing configured secret error = %v", err)
	}
}

func TestConfiguredSecretFileOverridesPlainValue(t *testing.T) {
	secretPath := filepath.Join(t.TempDir(), "database-url")
	if err := os.WriteFile(secretPath, []byte("postgres://from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_MODE", "development")
	t.Setenv("DATABASE_URL", "postgres://plain-value")
	t.Setenv("DATABASE_URL_FILE", secretPath)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DatabaseURL != "postgres://from-file" {
		t.Fatalf("database URL = %q, want file value", cfg.DatabaseURL)
	}
}

func TestRecognitionRequiresExplicitCommand(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_MODE", "development")
	t.Setenv("AUDIVERIS_COMMAND", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AudiverisCommand != "" {
		t.Fatalf("default Audiveris command = %q, want disabled", cfg.AudiverisCommand)
	}

	t.Setenv("AUDIVERIS_COMMAND", " scripts/run-audiveris-docker.sh ")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AudiverisCommand != "scripts/run-audiveris-docker.sh" {
		t.Fatalf("configured Audiveris command = %q", cfg.AudiverisCommand)
	}
}

func TestLoadRemoteOMRFromSecretFile(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "omr-token")
	if err := os.WriteFile(tokenPath, []byte("remote-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_MODE", "development")
	t.Setenv("OMR_BASE_URL", " http://192.168.1.2:8788/ ")
	t.Setenv("OMR_TOKEN_FILE", tokenPath)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.OMRBaseURL != "http://192.168.1.2:8788" {
		t.Fatalf("OMR base URL = %q", cfg.OMRBaseURL)
	}
	if cfg.OMRToken != "remote-token" {
		t.Fatalf("OMR token was not loaded from its configured file")
	}
}

func TestRemoteOMRConfigurationRequiresURLAndToken(t *testing.T) {
	base := Config{AppEnv: "development", AuthMode: "development", DevUserEmail: "learner@example.com"}
	for _, cfg := range []Config{
		func() Config { value := base; value.OMRBaseURL = "http://worker:8788"; return value }(),
		func() Config { value := base; value.OMRToken = "token"; return value }(),
	} {
		if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "configured together") {
			t.Fatalf("incomplete OMR configuration error = %v", err)
		}
	}
}

func TestRemoteOMRConfigurationRejectsAmbiguousOrUnsafeValues(t *testing.T) {
	base := Config{
		AppEnv:       "development",
		AuthMode:     "development",
		DevUserEmail: "learner@example.com",
		OMRBaseURL:   "http://worker:8788",
		OMRToken:     "token",
	}
	tests := []struct {
		name string
		edit func(*Config)
		want string
	}{
		{name: "local and remote", edit: func(cfg *Config) { cfg.AudiverisCommand = "audiveris" }, want: "cannot both"},
		{name: "relative URL", edit: func(cfg *Config) { cfg.OMRBaseURL = "/worker" }, want: "absolute"},
		{name: "URL credentials", edit: func(cfg *Config) { cfg.OMRBaseURL = "http://user:pass@worker:8788" }, want: "credentials"},
		{name: "token newline", edit: func(cfg *Config) { cfg.OMRToken = "token\nheader" }, want: "line breaks"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := base
			test.edit(&cfg)
			if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("configuration error = %v, want %q", err, test.want)
			}
		})
	}
}
