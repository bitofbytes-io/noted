package app_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationContinuePiece(t *testing.T) {
	databaseURL := os.Getenv("NOTED_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store, err := assets.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := app.NewService(pool, store)
	authService := auth.NewService(pool, nil, time.Hour)
	owner, err := authService.EnsureDevelopmentUser(ctx, "continue-owner@example.test")
	if err != nil {
		t.Fatal(err)
	}
	other, err := authService.EnsureDevelopmentUser(ctx, "continue-other@example.test")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = ANY($1::uuid[])`, []string{owner.ID, other.ID}); err != nil {
			t.Error(err)
		}
	}()

	continued := func(userID string) string {
		t.Helper()
		piece, err := service.ContinuePiece(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		if piece == nil {
			return ""
		}
		return piece.Title
	}
	if got := continued(owner.ID); got != "" {
		t.Fatalf("an empty library continues %q", got)
	}

	checksum := strings.Repeat("a", 64)
	create := func(userID, title, status string, playedHoursAgo int, pdf bool) {
		t.Helper()
		piece, err := service.CreatePiece(ctx, userID, app.PieceInput{Title: title, Status: &status})
		if err != nil {
			t.Fatal(err)
		}
		if pdf {
			if _, err := pool.Exec(ctx, `
				INSERT INTO piece_pdfs (piece_id, storage_key, original_filename, size_bytes, checksum_sha256, page_count)
				VALUES ($1, $2, 'score.pdf', 10, $3, 2)`, piece.ID, uuid.NewString(), checksum); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO reader_states (piece_id, updated_at)
			VALUES ($1, now() - $2::int * interval '1 hour')`,
			piece.ID, playedHoursAgo); err != nil {
			t.Fatal(err)
		}
	}
	create(owner.ID, "Old", app.StatusPlaying, 15*24, true)
	if got := continued(owner.ID); got != "" {
		t.Fatalf("a piece played 15 days ago continues: %q", got)
	}
	create(owner.ID, "Week", app.StatusPlaying, 7*24, true)
	// The whole library counts: a shelved piece played yesterday continues.
	create(owner.ID, "Shelved yesterday", app.StatusShelved, 24, true)
	// A piece without a PDF cannot be played, however recent its reader state.
	create(owner.ID, "No PDF", app.StatusLearning, 1, false)
	// Another user's plays never show.
	create(other.ID, "Theirs", app.StatusPlaying, 0, true)
	if got := continued(owner.ID); got != "Shelved yesterday" {
		t.Fatalf("continue = %q, want the shelved piece played yesterday", got)
	}
	if got := continued(other.ID); got != "Theirs" {
		t.Fatalf("other user's continue = %q", got)
	}
}
