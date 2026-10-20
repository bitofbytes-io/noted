package app_test

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationLibrarySummaries(t *testing.T) {
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
	owner, err := authService.EnsureDevelopmentUser(ctx, "summary-owner@example.test")
	if err != nil {
		t.Fatal(err)
	}
	other, err := authService.EnsureDevelopmentUser(ctx, "summary-other@example.test")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = ANY($1::uuid[])`, []string{owner.ID, other.ID}); err != nil {
			t.Error(err)
		}
	}()

	shelved := app.StatusShelved
	humoresque, err := service.CreatePiece(ctx, owner.ID, app.PieceInput{
		Title: "Humoresque Op. 101 No. 7", Composer: "Antonín Dvořák", Favorite: true,
		ListeningURL: "https://example.test/humoresque", Notes: "Slow, and singing", Status: &shelved,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO piece_pdfs (piece_id, storage_key, original_filename, size_bytes, checksum_sha256, page_count)
		VALUES ($1, $2, 'score.pdf', 10, $3, 3)`, humoresque.ID, uuid.NewString(), strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reader_states (piece_id) VALUES ($1)`, humoresque.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreatePiece(ctx, owner.ID, app.PieceInput{Title: "Arabesque No. 1", Composer: "Claude Debussy"}); err != nil {
		t.Fatal(err)
	}
	// Another user's piece never shows.
	if _, err := service.CreatePiece(ctx, other.ID, app.PieceInput{Title: "Nocturne", Composer: "Frédéric Chopin"}); err != nil {
		t.Fatal(err)
	}

	summaries, err := service.ListPieceSummaries(ctx, owner.ID, app.ListOptions{Sort: app.SortTitle})
	if err != nil {
		t.Fatal(err)
	}
	titles := []string{}
	for _, summary := range summaries {
		titles = append(titles, summary.Title)
	}
	if !slices.Equal(titles, []string{"Arabesque No. 1", "Humoresque Op. 101 No. 7"}) {
		t.Fatalf("summaries: %v", titles)
	}
	arabesque, got := summaries[0], summaries[1]
	if arabesque.PDF != nil || arabesque.LastPlayedAt != nil || arabesque.Status != app.StatusPlaying {
		t.Fatalf("arabesque summary: %+v", arabesque)
	}
	if got.ID != humoresque.ID || got.Composer != "Antonín Dvořák" || !got.Favorite ||
		got.Status != app.StatusShelved || got.ListeningURL != "https://example.test/humoresque" ||
		got.PDF == nil || got.PDF.PageCount != 3 || got.PDF.ContentURL != "/api/pieces/"+humoresque.ID+"/pdf" ||
		got.LastPlayedAt == nil || !got.CreatedAt.Equal(humoresque.CreatedAt) {
		t.Fatalf("humoresque summary: %+v", got)
	}
	// The notes come only as part of the folded search text, which ends with
	// the catalogue terms the fold lacks.
	if got.SearchText != "humoresque op 101 no 7 antonin dvorak slow and singing op101 no7" {
		t.Fatalf("search text = %q", got.SearchText)
	}

	// The list's filters and sorts apply to summaries too.
	favorite := true
	summaries, err = service.ListPieceSummaries(ctx, owner.ID, app.ListOptions{
		Query: "dvorak", Favorite: &favorite, Sort: app.SortComposer,
	})
	if err != nil || len(summaries) != 1 || summaries[0].ID != humoresque.ID {
		t.Fatalf("filtered summaries = %+v, error = %v", summaries, err)
	}
	if _, err := service.ListPieceSummaries(ctx, owner.ID, app.ListOptions{Sort: "played"}); err == nil {
		t.Fatal("an unknown sort was accepted")
	}
}
