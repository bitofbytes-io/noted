package config

import "testing"

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
