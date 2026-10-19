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

func TestIntegrationLibrarySorts(t *testing.T) {
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
	owner, err := authService.EnsureDevelopmentUser(ctx, "sort-owner@example.test")
	if err != nil {
		t.Fatal(err)
	}
	other, err := authService.EnsureDevelopmentUser(ctx, "sort-other@example.test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = ANY($1::uuid[])`, []string{owner.ID, other.ID})
	})

	checksum := strings.Repeat("a", 64)
	// Added a minute apart in this order, so Recently added lists them in reverse.
	added := 10
	create := func(title, composer string, playedMinutesAgo *int, pdf bool) app.Piece {
		t.Helper()
		piece, err := service.CreatePiece(ctx, owner.ID, app.PieceInput{Title: title, Composer: composer})
		if err != nil {
			t.Fatal(err)
		}
		added--
		if _, err := pool.Exec(ctx, `UPDATE pieces SET created_at=now() - $2::int * interval '1 minute' WHERE id=$1`,
			piece.ID, added); err != nil {
			t.Fatal(err)
		}
		if pdf {
			if _, err := pool.Exec(ctx, `
				INSERT INTO piece_pdfs (piece_id, storage_key, original_filename, size_bytes, checksum_sha256, page_count)
				VALUES ($1, $2, 'score.pdf', 10, $3, 2)`, piece.ID, uuid.NewString(), checksum); err != nil {
				t.Fatal(err)
			}
		}
		if playedMinutesAgo != nil {
			if _, err := pool.Exec(ctx, `
				INSERT INTO reader_states (piece_id, updated_at)
				VALUES ($1, now() - $2::int * interval '1 minute')`,
				piece.ID, *playedMinutesAgo); err != nil {
				t.Fatal(err)
			}
		}
		return piece
	}
	hour, days := 60, 3*24*60
	create("Arabesque No. 1", "Claude Debussy", &days, true)
	nocturne := create("Nocturne", "Frédéric Chopin", nil, true)
	create("Prelude in C", "Johann Sebastian Bach", &hour, true)
	create("Solfeggietto", "C. P. E. Bach", nil, false)
	create("Exercise", "", nil, true)
	// Another user's recently played piece never shows.
	if _, err := service.CreatePiece(ctx, other.ID, app.PieceInput{Title: "Aaa", Composer: "Aaron"}); err != nil {
		t.Fatal(err)
	}

	titles := func(sort, query string) []string {
		t.Helper()
		pieces, err := service.ListPieces(ctx, owner.ID, query, nil, nil, sort)
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
		sort, query string
		want        []string
	}{
		{app.SortTitle, "", []string{"Arabesque No. 1", "Exercise", "Nocturne", "Prelude in C", "Solfeggietto"}},
		// Surname, then the full name; no composer last.
		{app.SortComposer, "", []string{"Solfeggietto", "Prelude in C", "Nocturne", "Arabesque No. 1", "Exercise"}},
		// Newest play first; never played after, by title.
		{app.SortRecent, "", []string{"Prelude in C", "Arabesque No. 1", "Exercise", "Nocturne", "Solfeggietto"}},
		// Never played first, then the longest unplayed; no PDF last.
		{app.SortFresh, "", []string{"Exercise", "Nocturne", "Arabesque No. 1", "Prelude in C", "Solfeggietto"}},
		{app.SortAdded, "", []string{"Exercise", "Solfeggietto", "Prelude in C", "Nocturne", "Arabesque No. 1"}},
		// A search keeps the chosen sort.
		{app.SortRecent, "bach", []string{"Prelude in C", "Solfeggietto"}},
	} {
		if got := titles(test.sort, test.query); !slices.Equal(got, test.want) {
			t.Fatalf("sort=%s q=%q: got %v, want %v", test.sort, test.query, got, test.want)
		}
	}
	if _, err := service.ListPieces(ctx, owner.ID, "", nil, nil, "favorite DESC"); err == nil {
		t.Fatal("expected an unknown sort to fail")
	}

	// Each reader checkpoint is a play: it becomes the piece's last played time.
	pieces, err := service.ListPieces(ctx, owner.ID, "nocturne", nil, nil, app.SortTitle)
	if err != nil || len(pieces) != 1 || pieces[0].LastPlayedAt != nil {
		t.Fatalf("unplayed piece = %+v, error = %v", pieces, err)
	}
	state, err := service.PutReaderState(ctx, owner.ID, nocturne.ID, app.ReaderState{
		PDFChecksumSHA256: checksum, Mode: "page", LastPage: 2, Zoom: 1, ScrollSpeed: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := titles(app.SortRecent, ""); got[0] != "Nocturne" {
		t.Fatalf("after playing Nocturne, recent = %v", got)
	}
	piece, err := service.GetPiece(ctx, owner.ID, nocturne.ID)
	if err != nil || piece.LastPlayedAt == nil || !piece.LastPlayedAt.Equal(state.UpdatedAt) {
		t.Fatalf("played piece = %+v, state = %+v, error = %v", piece, state, err)
	}
}
