package app_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationUserOwnership(t *testing.T) {
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
	userA, err := authService.EnsureDevelopmentUser(ctx, "owner-a@example.test")
	if err != nil {
		t.Fatal(err)
	}
	userB, err := authService.EnsureDevelopmentUser(ctx, "owner-b@example.test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = ANY($1::uuid[])`, []string{userA.ID, userB.ID})
	})
	googleAuth := auth.NewService(pool, []string{"owner-a@example.test"}, time.Hour)
	googleUser, err := googleAuth.AuthenticateGoogle(ctx, auth.GoogleIdentity{
		Subject: "google-owner-a", Email: "OWNER-A@example.test",
		DisplayName: "Owner A", Verified: true,
	})
	if err != nil || googleUser.ID != userA.ID {
		t.Fatalf("linked Google user = %+v, error = %v", googleUser, err)
	}
	if _, err := googleAuth.AuthenticateGoogle(ctx, auth.GoogleIdentity{
		Subject: "not-allowed", Email: "other@example.test", Verified: true,
	}); !errors.Is(err, auth.ErrEmailNotAllowed) {
		t.Fatalf("disallowed Google identity error = %v", err)
	}
	token, _, err := googleAuth.NewSession(ctx, userA.ID, "integration-test", "192.0.2.10")
	if err != nil {
		t.Fatal(err)
	}
	var storedHash string
	if err := pool.QueryRow(ctx, `
		SELECT encode(token_hash,'hex') FROM user_sessions WHERE user_id=$1`,
		userA.ID).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if storedHash == "" || storedHash == token {
		t.Fatal("database did not store only the opaque session token hash")
	}
	resolved, err := googleAuth.ResolveSession(ctx, token)
	if err != nil || resolved.ID != userA.ID {
		t.Fatalf("resolved user = %+v, error = %v", resolved, err)
	}
	secondToken, _, err := googleAuth.NewSession(ctx, userA.ID, "integration-test-2", "192.0.2.11")
	if err != nil {
		t.Fatal(err)
	}
	authWithoutUserA := auth.NewService(pool, []string{"owner-b@example.test"}, time.Hour)
	if _, err := authWithoutUserA.ResolveSession(ctx, token); !errors.Is(err, auth.ErrNotAuthenticated) {
		t.Fatalf("removed allow-list user resolved with error %v", err)
	}
	if _, err := googleAuth.ResolveSession(ctx, secondToken); !errors.Is(err, auth.ErrNotAuthenticated) {
		t.Fatalf("second session for removed allow-list user resolved with error %v", err)
	}
	var remainingSessions int
	if err := pool.QueryRow(
		ctx, `SELECT count(*) FROM user_sessions WHERE user_id=$1`, userA.ID,
	).Scan(&remainingSessions); err != nil {
		t.Fatal(err)
	}
	if remainingSessions != 0 {
		t.Fatalf("remaining sessions for removed allow-list user = %d, want 0", remainingSessions)
	}

	pieceA, err := service.CreatePiece(ctx, userA.ID, app.PieceInput{
		Title: "Private prelude", Composer: "Composer A", Favorite: true,
		SourceURL:    "https://scores.example.test/prelude",
		ListeningURL: "  https://listen.example.test/prelude  ",
	})
	if err != nil {
		t.Fatal(err)
	}
	if pieceA.SourceURL != "https://scores.example.test/prelude" ||
		pieceA.ListeningURL != "https://listen.example.test/prelude" {
		t.Fatalf("created piece URLs = source %q, listening %q", pieceA.SourceURL, pieceA.ListeningURL)
	}
	pieceB, err := service.CreatePiece(ctx, userB.ID, app.PieceInput{
		Title: "Private sonata", Composer: "Composer B",
	})
	if err != nil {
		t.Fatal(err)
	}
	listA, err := service.ListPieces(ctx, userA.ID, "", nil)
	if err != nil || len(listA) != 1 || listA[0].ID != pieceA.ID {
		t.Fatalf("user A list = %+v, error = %v", listA, err)
	}
	if listA[0].ListeningURL != pieceA.ListeningURL {
		t.Fatalf("user A list listening URL = %q, want %q", listA[0].ListeningURL, pieceA.ListeningURL)
	}
	listB, err := service.ListPieces(ctx, userB.ID, "", nil)
	if err != nil || len(listB) != 1 || listB[0].ID != pieceB.ID {
		t.Fatalf("user B list = %+v, error = %v", listB, err)
	}

	if _, err := service.GetPiece(ctx, userB.ID, pieceA.ID); !errors.Is(err, app.ErrNotFound) {
		t.Fatalf("cross-user GetPiece error = %v", err)
	}
	if _, err := service.UpdatePiece(ctx, userB.ID, pieceA.ID, app.PiecePatch{}); !errors.Is(err, app.ErrNotFound) {
		t.Fatalf("cross-user UpdatePiece error = %v", err)
	}
	updatedListeningURL := "https://listen.example.test/prelude-revised"
	updatedA, err := service.UpdatePiece(ctx, userA.ID, pieceA.ID, app.PiecePatch{
		ListeningURL: &updatedListeningURL,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updatedA.ListeningURL != updatedListeningURL || updatedA.SourceURL != pieceA.SourceURL {
		t.Fatalf("updated piece URLs = source %q, listening %q", updatedA.SourceURL, updatedA.ListeningURL)
	}
	if err := service.DeletePiece(ctx, userB.ID, pieceA.ID); !errors.Is(err, app.ErrNotFound) {
		t.Fatalf("cross-user DeletePiece error = %v", err)
	}
	fixture, err := os.ReadFile("../../testdata/fixtures/noted-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UploadPDF(
		ctx, userA.ID, pieceA.ID, "score.pdf", 2, bytes.NewReader(fixture),
	); err != nil {
		t.Fatal(err)
	}
	if _, reader, err := service.PDFSource(ctx, userB.ID, pieceA.ID); !errors.Is(err, app.ErrNotFound) {
		if reader != nil {
			_ = reader.Close()
		}
		t.Fatalf("cross-user PDFSource error = %v", err)
	}
	if _, err := service.GetReaderState(ctx, userB.ID, pieceA.ID); !errors.Is(err, app.ErrNotFound) {
		t.Fatalf("cross-user GetReaderState error = %v", err)
	}
	if _, err := service.PutReaderState(ctx, userB.ID, pieceA.ID, app.ReaderState{
		Mode: "page", LastPage: 1, Zoom: 1, ScrollSpeed: 32, ScrollPaused: true,
	}); !errors.Is(err, app.ErrNotFound) {
		t.Fatalf("cross-user PutReaderState error = %v", err)
	}
}
