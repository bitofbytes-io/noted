package app_test

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationLibrarySearch(t *testing.T) {
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
	owner, err := authService.EnsureDevelopmentUser(ctx, "search-owner@example.test")
	if err != nil {
		t.Fatal(err)
	}
	other, err := authService.EnsureDevelopmentUser(ctx, "search-other@example.test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = ANY($1::uuid[])`, []string{owner.ID, other.ID})
	})

	create := func(userID string, input app.PieceInput) app.Piece {
		t.Helper()
		piece, err := service.CreatePiece(ctx, userID, input)
		if err != nil {
			t.Fatal(err)
		}
		return piece
	}
	create(owner.ID, app.PieceInput{Title: "Humoresque Op. 101 No. 7", Composer: "Antonín Dvořák"})
	create(owner.ID, app.PieceInput{Title: "Pavane, Op. 50", Composer: "Gabriel Fauré"})
	create(owner.ID, app.PieceInput{Title: "Nocturne in C♯ minor", Composer: "Frédéric Chopin"})
	create(owner.ID, app.PieceInput{Title: "Prelude Op.28/4", Composer: "Frédéric Chopin"})
	sonata := create(owner.ID, app.PieceInput{Title: "Piano Sonata No. 14", Composer: "Ludwig van Beethoven"})
	create(owner.ID, app.PieceInput{Title: "100% Ragtime", Composer: "Scott Joplin", Notes: "Swing the eighths"})
	// Another user's matching piece never shows.
	create(other.ID, app.PieceInput{Title: "Nocturne Op. 9 No. 2", Composer: "Frédéric Chopin", Aliases: "Moonlight Sonata"})

	titles := func(query string) []string {
		t.Helper()
		pieces, err := service.ListPieces(ctx, owner.ID, app.ListOptions{Query: query, Sort: app.SortTitle})
		if err != nil {
			t.Fatal(err)
		}
		names := []string{}
		for _, piece := range pieces {
			names = append(names, piece.Title)
		}
		return names
	}
	for _, test := range []struct {
		query string
		want  []string
	}{
		// Accents fold away on either side.
		{"dvorak", []string{"Humoresque Op. 101 No. 7"}},
		{"DVOŘÁK", []string{"Humoresque Op. 101 No. 7"}},
		{"faure", []string{"Pavane, Op. 50"}},
		// Every word must match, in any field and any order.
		{"chopin nocturne", []string{"Nocturne in C♯ minor"}},
		{"nocturne chopin", []string{"Nocturne in C♯ minor"}},
		{"chopin waltz", []string{}},
		{"c# minor", []string{"Nocturne in C♯ minor"}},
		{"op 28/4", []string{"Prelude Op.28/4"}},
		// Notes are searched too.
		{"eighths", []string{"100% Ragtime"}},
		// LIKE wildcards are literal: % and _ are punctuation, so they split
		// words rather than match any text.
		{"100%", []string{"100% Ragtime"}},
		{"ragtime%joplin", []string{"100% Ragtime"}},
		{"op_50", []string{"Pavane, Op. 50"}},
		{"sonata", []string{"Piano Sonata No. 14"}},
	} {
		if got := titles(test.query); !slices.Equal(got, test.want) {
			t.Fatalf("q=%q: got %v, want %v", test.query, got, test.want)
		}
	}
	// Punctuation alone is no search.
	if got := titles("%"); len(got) != 6 {
		t.Fatalf("q=%%: got %v, want every piece", got)
	}

	// Aliases are searchable once set, and an edit refreshes the search text.
	if got := titles("moonlight"); len(got) != 0 {
		t.Fatalf("moonlight before the alias: %v", got)
	}
	aliases := "  Moonlight Sonata "
	updated, err := service.UpdatePiece(ctx, owner.ID, sonata.ID, app.PiecePatch{Aliases: &aliases})
	if err != nil || updated.Aliases != "Moonlight Sonata" {
		t.Fatalf("aliases = %q, error = %v", updated.Aliases, err)
	}
	if got := titles("moonlight beethoven"); !slices.Equal(got, []string{"Piano Sonata No. 14"}) {
		t.Fatalf("moonlight beethoven: %v", got)
	}
	title := "Sonata quasi una fantasia"
	if _, err := service.UpdatePiece(ctx, owner.ID, sonata.ID, app.PiecePatch{Title: &title}); err != nil {
		t.Fatal(err)
	}
	if got := titles("fantasia moonlight"); !slices.Equal(got, []string{title}) {
		t.Fatalf("after a title edit: %v", got)
	}
	if got := titles("piano sonata 14"); len(got) != 0 {
		t.Fatalf("old title still matches: %v", got)
	}

	// The startup refold rewrites stale search text once per fold version.
	if _, err := pool.Exec(ctx, `UPDATE pieces SET search_text='' WHERE id=$1`, sonata.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE search_index_state SET fold_version=0`); err != nil {
		t.Fatal(err)
	}
	if refolded, err := service.RefoldSearchText(ctx); err != nil || refolded == 0 {
		t.Fatalf("refolded %d, error = %v", refolded, err)
	}
	if got := titles("moonlight"); !slices.Equal(got, []string{title}) {
		t.Fatalf("after refold: %v", got)
	}
	if refolded, err := service.RefoldSearchText(ctx); err != nil || refolded != 0 {
		t.Fatalf("second refold = %d, error = %v", refolded, err)
	}
}
