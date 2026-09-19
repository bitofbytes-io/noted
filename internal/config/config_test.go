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

func TestProductionRequiresSafeExplicitBrowserURLs(t *testing.T) {
	tests := []struct {
		name          string
		allowedOrigin string
		frontendURL   string
		wantError     string
	}{
		{
			name:        "missing allowed origin",
			frontendURL: "https://noted.example.test",
			wantError:   "ALLOWED_ORIGIN must be configured",
		},
		{
			name:          "malformed allowed origin",
			allowedOrigin: "not an origin",
			frontendURL:   "https://noted.example.test",
			wantError:     "ALLOWED_ORIGIN must be an absolute URL",
		},
		{
			name:          "allowed origin includes a path",
			allowedOrigin: "https://noted.example.test/app",
			frontendURL:   "https://noted.example.test",
			wantError:     "ALLOWED_ORIGIN must contain only scheme and host",
		},
		{
			name:          "local allowed origin",
			allowedOrigin: "https://localhost:4200",
			frontendURL:   "https://noted.example.test",
			wantError:     "ALLOWED_ORIGIN must not use a local address",
		},
		{
			name:          "non HTTPS allowed origin",
			allowedOrigin: "http://noted.example.test",
			frontendURL:   "https://noted.example.test",
			wantError:     "ALLOWED_ORIGIN must use HTTPS",
		},
		{
			name:          "missing frontend URL",
			allowedOrigin: "https://noted.example.test",
			wantError:     "FRONTEND_URL must be configured",
		},
		{
			name:          "local frontend URL",
			allowedOrigin: "https://noted.example.test",
			frontendURL:   "https://127.0.0.1",
			wantError:     "FRONTEND_URL must not use a local address",
		},
		{
			name:          "non HTTPS frontend URL",
			allowedOrigin: "https://noted.example.test",
			frontendURL:   "http://noted.example.test",
			wantError:     "FRONTEND_URL must use HTTPS",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			setProductionGoogleEnvironment(t)
			t.Setenv("ALLOWED_ORIGIN", test.allowedOrigin)
			t.Setenv("FRONTEND_URL", test.frontendURL)

			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("Load() error = %v, want %q", err, test.wantError)
			}
		})
	}
}

func TestProductionAcceptsExplicitHTTPSBrowserURLs(t *testing.T) {
	setProductionGoogleEnvironment(t)
	t.Setenv("ALLOWED_ORIGIN", "https://noted.example.test")
	t.Setenv("FRONTEND_URL", "https://noted.example.test/app")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AllowedOrigin != "https://noted.example.test" ||
		cfg.FrontendURL != "https://noted.example.test/app" {
		t.Fatalf("browser URLs = %q, %q", cfg.AllowedOrigin, cfg.FrontendURL)
	}
}

func TestDevelopmentRetainsLocalBrowserURLDefaults(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("ALLOWED_ORIGIN", "")
	t.Setenv("ALLOWED_ORIGINS", "")
	t.Setenv("FRONTEND_URL", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AllowedOrigin != "http://localhost:4200" ||
		cfg.FrontendURL != "http://localhost:4200" {
		t.Fatalf("browser URL defaults = %q, %q", cfg.AllowedOrigin, cfg.FrontendURL)
	}
}

func setProductionGoogleEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("APP_ENV", "production")
	t.Setenv("AUTH_MODE", "google")
	t.Setenv("AUTH_GOOGLE_CLIENT_ID", "client")
	t.Setenv("AUTH_GOOGLE_CLIENT_SECRET", "secret")
	t.Setenv("AUTH_GOOGLE_REDIRECT_URL", "https://api.example.test/api/auth/google/callback")
	t.Setenv("AUTH_GOOGLE_ALLOWED_EMAILS", "owner@example.test")
	t.Setenv("ALLOWED_ORIGIN", "")
	t.Setenv("ALLOWED_ORIGINS", "")
	t.Setenv("FRONTEND_URL", "")
}
