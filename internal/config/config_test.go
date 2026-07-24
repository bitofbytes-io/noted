package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
