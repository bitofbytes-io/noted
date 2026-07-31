package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadDefaultsSessionTTLToNinetyDays(t *testing.T) {
	t.Setenv("SESSION_TTL", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if want := 90 * 24 * time.Hour; cfg.SessionTTL != want {
		t.Fatalf("SessionTTL = %v, want %v", cfg.SessionTTL, want)
	}
}

func TestLoadUsesSessionTTLOverride(t *testing.T) {
	t.Setenv("SESSION_TTL", "12h")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if want := 12 * time.Hour; cfg.SessionTTL != want {
		t.Fatalf("SessionTTL = %v, want %v", cfg.SessionTTL, want)
	}
}

func TestLoadReadsDatabaseURLFromSecretFile(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	path := filepath.Join(t.TempDir(), "database-url")
	if err := os.WriteFile(path, []byte("postgres://secret/noted\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DATABASE_URL_FILE", path)

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DatabaseURL != "postgres://secret/noted" {
		t.Fatalf("DatabaseURL = %q", cfg.DatabaseURL)
	}
}

func TestLoadPrefersDatabaseURLToSecretFile(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://environment/noted")
	t.Setenv("DATABASE_URL_FILE", filepath.Join(t.TempDir(), "missing"))

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DatabaseURL != "postgres://environment/noted" {
		t.Fatalf("DatabaseURL = %q", cfg.DatabaseURL)
	}
}

func TestLoadRejectsEmptyDatabaseSecret(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	path := filepath.Join(t.TempDir(), "database-url")
	if err := os.WriteFile(path, []byte("\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DATABASE_URL_FILE", path)

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "is empty") {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestLoadDatabaseURLDoesNotRequireApplicationAuthentication(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://migration/noted")
	t.Setenv("APP_ENV", "production")
	t.Setenv("AUTH_MODE", "google")
	t.Setenv("AUTH_GOOGLE_CLIENT_ID", "")
	t.Setenv("AUTH_GOOGLE_CLIENT_SECRET", "")
	t.Setenv("AUTH_GOOGLE_REDIRECT_URL", "")
	t.Setenv("AUTH_GOOGLE_ALLOWED_EMAILS", "")

	databaseURL, err := LoadDatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	if databaseURL != "postgres://migration/noted" {
		t.Fatalf("databaseURL = %q", databaseURL)
	}
}

func TestLoadAcceptsDeployedAllowedOriginsName(t *testing.T) {
	t.Setenv("ALLOWED_ORIGIN", "")
	t.Setenv("ALLOWED_ORIGINS", "https://noted.bitofbytes.io")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AllowedOrigin != "https://noted.bitofbytes.io" {
		t.Fatalf("AllowedOrigin = %q", cfg.AllowedOrigin)
	}
}

func TestLoadNormalizesAndDeduplicatesAllowedEmails(t *testing.T) {
	t.Setenv("AUTH_MODE", "google")
	t.Setenv("AUTH_GOOGLE_CLIENT_ID", "client")
	t.Setenv("AUTH_GOOGLE_CLIENT_SECRET", "secret")
	t.Setenv("AUTH_GOOGLE_REDIRECT_URL", "http://localhost:8080/api/auth/google/callback")
	t.Setenv("AUTH_GOOGLE_ALLOWED_EMAILS", " DanWater1@gmail.com,danwater1@gmail.com, AIDEN.RAY.WATERS@gmail.com ")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.AllowedEmails) != 2 ||
		cfg.AllowedEmails[0] != "danwater1@gmail.com" ||
		cfg.AllowedEmails[1] != "aiden.ray.waters@gmail.com" {
		t.Fatalf("AllowedEmails = %#v", cfg.AllowedEmails)
	}
}

func TestProductionRequiresGoogleAuthentication(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("AUTH_MODE", "development")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("Load() error = %v", err)
	}
}
