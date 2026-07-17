package auth

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

func integrationAuthService(t *testing.T) *Service {
	t.Helper()
	if os.Getenv("NOTED_INTEGRATION") != "1" {
		t.Skip("set NOTED_INTEGRATION=1 with migrated local PostgreSQL running")
	}
	_ = godotenv.Load("../../.env")
	databaseURL, err := config.LoadDatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return NewService(pool, []string{"oauth-integration@example.test"}, 12*time.Hour)
}

func TestIntegrationGoogleIdentityAndOpaqueSessionLifecycle(t *testing.T) {
	service := integrationAuthService(t)
	ctx := context.Background()
	identity := GoogleIdentity{
		Subject:     "integration-google-subject",
		Email:       "oauth-integration@example.test",
		DisplayName: "OAuth integration learner",
		Verified:    true,
	}
	user, err := service.AuthenticateGoogle(ctx, identity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = service.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, user.ID)
	})

	token, _, err := service.NewSession(ctx, user.ID, "integration-test", "192.0.2.10")
	if err != nil {
		t.Fatal(err)
	}
	var storedHash string
	if err := service.Pool.QueryRow(ctx, `SELECT encode(token_hash,'hex') FROM user_sessions WHERE user_id=$1`, user.ID).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if storedHash == "" || strings.Contains(storedHash, token) {
		t.Fatal("database did not store only an opaque token hash")
	}
	resolved, err := service.ResolveSession(ctx, token)
	if err != nil || resolved.ID != user.ID {
		t.Fatalf("resolved session user = %+v, error = %v", resolved, err)
	}
	if err := service.DeleteSession(ctx, token); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ResolveSession(ctx, token); !errors.Is(err, ErrNotAuthenticated) {
		t.Fatalf("deleted session resolved with error %v", err)
	}
}

func TestIntegrationOAuthStateIsSingleUse(t *testing.T) {
	service := integrationAuthService(t)
	ctx := context.Background()
	state, err := service.NewLoginState(ctx, "/works/123")
	if err != nil {
		t.Fatal(err)
	}
	path, err := service.ConsumeLoginState(ctx, state)
	if err != nil || path != "/works/123" {
		t.Fatalf("consumed path = %q, error = %v", path, err)
	}
	if _, err := service.ConsumeLoginState(ctx, state); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("reused OAuth state error = %v", err)
	}
}
