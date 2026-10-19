package app_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationPieceStatusAndLibraryFilter(t *testing.T) {
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
	owner, err := authService.EnsureDevelopmentUser(ctx, "status-owner@example.test")
	if err != nil {
		t.Fatal(err)
	}
	other, err := authService.EnsureDevelopmentUser(ctx, "status-other@example.test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = ANY($1::uuid[])`, []string{owner.ID, other.ID})
	})

	playing, err := service.CreatePiece(ctx, owner.ID, app.PieceInput{Title: "Arabesque", Composer: "Debussy"})
	if err != nil || playing.Status != app.StatusPlaying {
		t.Fatalf("default status piece = %+v, error = %v", playing, err)
	}
	learningStatus, empty := app.StatusLearning, ""
	learning, err := service.CreatePiece(ctx, owner.ID, app.PieceInput{Title: "Nocturne", Composer: "Chopin", Status: &learningStatus})
	if err != nil || learning.Status != app.StatusLearning {
		t.Fatalf("learning piece = %+v, error = %v", learning, err)
	}
	if _, err := service.CreatePiece(ctx, owner.ID, app.PieceInput{Title: "Etude", Status: &empty}); err == nil {
		t.Fatal("expected an explicitly empty status on create to fail")
	}
	shelved, err := service.CreatePiece(ctx, owner.ID, app.PieceInput{Title: "Prelude", Composer: "Chopin", Favorite: true})
	if err != nil {
		t.Fatal(err)
	}
	status := app.StatusShelved
	if _, err := service.UpdatePiece(ctx, other.ID, shelved.ID, app.PiecePatch{Status: &status}); !errors.Is(err, app.ErrNotFound) {
		t.Fatalf("cross-user status change error = %v", err)
	}
	if shelved, err = service.UpdatePiece(ctx, owner.ID, shelved.ID, app.PiecePatch{Status: &status}); err != nil ||
		shelved.Status != app.StatusShelved || !shelved.Favorite || shelved.Title != "Prelude" {
		t.Fatalf("shelved piece = %+v, error = %v", shelved, err)
	}
	if _, err := service.UpdatePiece(ctx, owner.ID, shelved.ID, app.PiecePatch{Status: &empty}); err == nil {
		t.Fatal("expected an empty status patch to fail")
	}

	titles := func(query string, favorite *bool, statusParam string) []string {
		t.Helper()
		statuses, err := app.ParseStatusFilter(statusParam, query)
		if err != nil {
			t.Fatal(err)
		}
		pieces, err := service.ListPieces(ctx, owner.ID, query, favorite, statuses, app.SortTitle)
		if err != nil {
			t.Fatal(err)
		}
		names := []string{}
		for _, piece := range pieces {
			names = append(names, piece.Title)
		}
		return names
	}
	favorite := true
	for _, test := range []struct {
		name        string
		query       string
		favorite    *bool
		statusParam string
		want        []string
	}{
		{"default hides shelved", "", nil, "", []string{"Arabesque", "Nocturne"}},
		{"search shows shelved", "chopin", nil, "", []string{"Nocturne", "Prelude"}},
		{"explicit filter applies to search", "chopin", nil, "learning", []string{"Nocturne"}},
		{"shelved", "", nil, "shelved", []string{"Prelude"}},
		// Title order, with no favorites pinned first.
		{"all", "", nil, "all", []string{"Arabesque", "Nocturne", "Prelude"}},
		{"favorites of any status", "", &favorite, "all", []string{"Prelude"}},
	} {
		if got := titles(test.query, test.favorite, test.statusParam); !slices.Equal(got, test.want) {
			t.Fatalf("%s: got %v, want %v", test.name, got, test.want)
		}
	}

	// Finalizing a draft replaces the PDF and metadata but keeps the status.
	fixture, err := os.ReadFile("../../testdata/fixtures/noted-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}
	draft, err := service.CreateImport(ctx, owner.ID, app.CreateImport{PieceID: shelved.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateImport(ctx, owner.ID, draft.ID, app.UpdateImport{
		Revision: draft.Revision, Metadata: app.PieceInput{Title: "Prelude", Status: &learningStatus},
		Manifest: draft.Manifest,
	}); err == nil {
		t.Fatal("expected a draft that sets the status to fail")
	}
	if draft, err = service.UploadImportSource(ctx, owner.ID, draft.ID, "score.pdf", draft.Revision, bytes.NewReader(fixture)); err != nil {
		t.Fatal(err)
	}
	finalized, err := service.FinalizeImport(ctx, owner.ID, draft.ID, draft.Revision, bytes.NewReader(fixture))
	if err != nil || finalized.Status != app.StatusShelved {
		t.Fatalf("finalized piece = %+v, error = %v", finalized, err)
	}

	// The remembered filter starts at the default and is private to its user.
	if preferences, err := service.GetPreferences(ctx, owner.ID); err != nil ||
		preferences != (app.Preferences{LibraryFilter: "current", LibrarySort: app.SortTitle}) {
		t.Fatalf("first-time preferences = %+v, error = %v", preferences, err)
	}
	favorites, archived, composer, played := "favorites", "archived", app.SortComposer, "played"
	if _, err := service.PutPreferences(ctx, owner.ID, app.PreferencesPatch{LibraryFilter: &favorites}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.PutPreferences(ctx, owner.ID, app.PreferencesPatch{LibraryFilter: &archived}); err == nil {
		t.Fatal("expected an unknown library filter to fail")
	}
	// Saving the sort keeps the filter, and an unknown sort changes nothing.
	if preferences, err := service.PutPreferences(ctx, owner.ID, app.PreferencesPatch{LibrarySort: &composer}); err != nil ||
		preferences != (app.Preferences{LibraryFilter: "favorites", LibrarySort: app.SortComposer}) {
		t.Fatalf("saved sort = %+v, error = %v", preferences, err)
	}
	// A valid filter alongside it is not saved either.
	all := "all"
	if _, err := service.PutPreferences(ctx, owner.ID, app.PreferencesPatch{LibrarySort: &played, LibraryFilter: &all}); err == nil {
		t.Fatal("expected an unknown library sort to fail")
	}
	if preferences, err := service.GetPreferences(ctx, owner.ID); err != nil ||
		preferences != (app.Preferences{LibraryFilter: "favorites", LibrarySort: app.SortComposer}) {
		t.Fatalf("remembered preferences = %+v, error = %v", preferences, err)
	}
	if preferences, err := service.GetPreferences(ctx, other.ID); err != nil ||
		preferences != (app.Preferences{LibraryFilter: "current", LibrarySort: app.SortTitle}) {
		t.Fatalf("other user's preferences = %+v, error = %v", preferences, err)
	}
}
