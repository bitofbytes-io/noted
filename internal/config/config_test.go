package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	cfg.AllowedEmails = []string{"learner@example.com"}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected complete google auth configuration to pass: %v", err)
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
