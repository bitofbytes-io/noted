package auth

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationShortcutTokens(t *testing.T) {
	url := os.Getenv("NOTED_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	s := NewService(pool, nil, time.Hour)
	now := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	owner, other := uuid.NewString(), uuid.NewString()
	for _, id := range []string{owner, other} {
		if _, err = pool.Exec(ctx, `INSERT INTO users(id,email,display_name,auth_provider) VALUES($1,$2,'Token tester','development')`, id, "token-"+id+"@example.test"); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1::uuid[])`, []string{owner, other})
	})

	if status, err := s.ShortcutTokenStatus(ctx, owner); err != nil || status.Active || status.CreatedAt != nil {
		t.Fatalf("no token yet: %+v %v", status, err)
	}
	first, createdAt, err := s.CreateShortcutToken(ctx, owner)
	if err != nil || len(first) != 43 || !createdAt.Equal(now) {
		t.Fatalf("create: %d chars at %v, %v", len(first), createdAt, err)
	}
	var stored []byte
	if err = pool.QueryRow(ctx, `SELECT token_hash FROM shortcut_tokens WHERE user_id=$1`, owner).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if hash := tokenHash(first); string(stored) != string(hash[:]) {
		t.Fatal("the stored value is not the token's SHA-256")
	}
	status, err := s.ShortcutTokenStatus(ctx, owner)
	if err != nil || !status.Active || status.CreatedAt == nil || !status.CreatedAt.Equal(now) || status.LastUsedAt != nil {
		t.Fatalf("active token: %+v %v", status, err)
	}
	user, err := s.ResolveShortcutToken(ctx, first)
	if err != nil || user.ID != owner {
		t.Fatalf("resolve: %+v %v", user, err)
	}

	now = now.Add(time.Hour)
	if err = s.TouchShortcutToken(ctx, first); err != nil {
		t.Fatal(err)
	}
	if status, _ = s.ShortcutTokenStatus(ctx, owner); status.LastUsedAt == nil || !status.LastUsedAt.Equal(now) {
		t.Fatalf("last use: %+v", status)
	}

	// Replace: one row per user, the old token stops working, the new one has no use yet.
	second, _, err := s.CreateShortcutToken(ctx, owner)
	if err != nil || second == first {
		t.Fatalf("replace: %v", err)
	}
	if _, err = s.ResolveShortcutToken(ctx, first); !errors.Is(err, ErrNotAuthenticated) {
		t.Fatalf("replaced token still resolves: %v", err)
	}
	if user, err = s.ResolveShortcutToken(ctx, second); err != nil || user.ID != owner {
		t.Fatalf("replacement: %+v %v", user, err)
	}
	// A late use of the replaced token does not mark the new one.
	if err = s.TouchShortcutToken(ctx, first); err != nil {
		t.Fatal(err)
	}
	if status, _ = s.ShortcutTokenStatus(ctx, owner); status.LastUsedAt != nil {
		t.Fatalf("the old token's use marked the new one: %+v", status)
	}
	var rows int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM shortcut_tokens WHERE user_id=$1`, owner).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("token rows = %d, %v", rows, err)
	}
	if _, err = s.ResolveShortcutToken(ctx, ""); !errors.Is(err, ErrNotAuthenticated) {
		t.Fatalf("empty token: %v", err)
	}

	// Each user's token is separate, and turning one off leaves the other.
	otherToken, _, err := s.CreateShortcutToken(ctx, other)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteShortcutToken(ctx, owner); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ResolveShortcutToken(ctx, second); !errors.Is(err, ErrNotAuthenticated) {
		t.Fatalf("turned-off token resolves: %v", err)
	}
	if status, _ = s.ShortcutTokenStatus(ctx, owner); status.Active {
		t.Fatal("turned-off token is still active")
	}
	if err = s.DeleteShortcutToken(ctx, owner); err != nil {
		t.Fatalf("turning off twice: %v", err)
	}
	if user, err = s.ResolveShortcutToken(ctx, otherToken); err != nil || user.ID != other {
		t.Fatalf("other user's token: %+v %v", user, err)
	}

	// Deleting a user removes their token.
	if _, err = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, other); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ResolveShortcutToken(ctx, otherToken); !errors.Is(err, ErrNotAuthenticated) {
		t.Fatalf("deleted user's token resolves: %v", err)
	}
}
