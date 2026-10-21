package app

import (
	"errors"
	"slices"
	"testing"
)

func TestIntegrationMusicalMetadataAndSearch(t *testing.T) {
	ctx, s, owner, other := exportIntegrationSetup(t)
	create := func(user string, in PieceInput) Piece {
		t.Helper()
		p, err := s.CreatePiece(ctx, user, in)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	exact := create(owner, PieceInput{Title: "Z etude", Composer: "Bach", Opus: " Op. 10 ", MusicKey: " C♯ minor ", Favorite: true})
	second := create(owner, PieceInput{Title: "A etude", Composer: "Chopin", Opus: "Op. 10", MusicKey: "C♯ minor", Favorite: true})
	prefix := create(owner, PieceInput{Title: "Op. 101", Composer: "Bach"})
	create(owner, PieceInput{Title: "Op. 106", Composer: "Chopin"})
	create(owner, PieceInput{Title: "Scherzo in F♯ minor", Composer: "Chopin"})
	create(owner, PieceInput{Title: "Chopin's 24 Préludes"})
	create(owner, PieceInput{Title: "Op.", Notes: "99"})
	flat := create(owner, PieceInput{Title: "Flat study", MusicKey: "E♭ major"})
	create(other, PieceInput{Title: "Foreign", Opus: "Op. 10", MusicKey: "C♯ minor", Favorite: true})
	if exact.Opus != "Op. 10" || exact.MusicKey != "C♯ minor" || prefix.Opus != "" || prefix.MusicKey != "" {
		t.Fatal("metadata defaults/trim", exact, prefix)
	}
	for _, tc := range []struct {
		q    string
		want []string
	}{
		{"c# minor", []string{second.ID, exact.ID}}, {"s24", []string{}}, {"op99", []string{}}, {"Eb", []string{flat.ID}}, {"E♭", []string{flat.ID}}, {"es-dur", []string{flat.ID}},
	} {
		got, err := s.ListPieces(ctx, owner, ListOptions{Query: tc.q, Sort: SortTitle})
		if err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, p := range got {
			ids = append(ids, p.ID)
		}
		if !slices.Equal(ids, tc.want) {
			t.Fatalf("%s: %v want %v", tc.q, ids, tc.want)
		}
	}
	partial, err := s.ListPieces(ctx, owner, ListOptions{Query: "op10 ba", Sort: SortTitle})
	if err != nil || len(partial) != 2 || partial[0].ID != exact.ID || partial[1].ID != prefix.ID {
		t.Fatal("partial composer erased exact catalogue rank", partial, err)
	}
	favorites := true
	for _, favorite := range []*bool{nil, &favorites} {
		opts := ListOptions{Query: "op10", Sort: SortComposer, Favorite: favorite}
		pieces, err := s.ListPieces(ctx, owner, opts)
		if err != nil {
			t.Fatal(err)
		}
		summaries, err := s.ListPieceSummaries(ctx, owner, opts)
		if err != nil {
			t.Fatal(err)
		}
		if len(pieces) < 2 || pieces[0].ID != exact.ID || pieces[1].ID != second.ID || summaries[0].ID != exact.ID || summaries[1].ID != second.ID {
			t.Fatal("exact terms lost rank or selected composer order", pieces, summaries)
		}
		if favorite != nil && len(pieces) != 2 {
			t.Fatal("favorite leaked")
		}
	}
	notes := "Updated notes"
	kept, err := s.UpdatePiece(ctx, owner, exact.ID, PiecePatch{Notes: &notes})
	if err != nil || kept.Opus != exact.Opus || kept.MusicKey != exact.MusicKey {
		t.Fatal("missing patch cleared metadata", kept, err)
	}
	if _, err = s.UpdatePiece(ctx, other, exact.ID, PiecePatch{Opus: &notes}); err != ErrNotFound {
		t.Fatal("foreign metadata patch", err)
	}
	// Refold derived columns without touching metadata timestamps, once per version.
	if _, err = s.pool.Exec(ctx, `UPDATE search_index_state SET fold_version=2; UPDATE pieces SET search_text=''`); err != nil {
		t.Fatal(err)
	}
	if n, err := s.RefoldSearchText(ctx); err != nil || n == 0 {
		t.Fatal(n, err)
	}
	refolded, err := s.GetPiece(ctx, owner, exact.ID)
	if err != nil || !refolded.UpdatedAt.Equal(kept.UpdatedAt) {
		t.Fatal("refold changed timestamp", refolded, err)
	}
	rows, err := s.ListPieces(ctx, owner, ListOptions{Query: "op10 c# minor", Sort: SortTitle})
	if err != nil || len(rows) != 2 {
		t.Fatal("refold omitted metadata", rows, err)
	}
	if n, err := s.RefoldSearchText(ctx); err != nil || n != 0 {
		t.Fatal("refold not idempotent", n, err)
	}
	// Simulate an old writer after v3 startup: the marker stays current while
	// derived search text becomes stale. The post-rollout command repairs it.
	if _, err = s.pool.Exec(ctx, `UPDATE pieces SET search_text='old writer' WHERE id=$1`, exact.ID); err != nil {
		t.Fatal(err)
	}
	if n, err := s.RefoldSearchText(ctx); err != nil || n != 0 {
		t.Fatal("startup marker", n, err)
	}
	for range 2 {
		if n, err := s.ForceRefoldSearchText(ctx); err != nil || n == 0 {
			t.Fatal("forced repair", n, err)
		}
		p, err := s.GetPiece(ctx, owner, exact.ID)
		if err != nil || !p.UpdatedAt.Equal(kept.UpdatedAt) || p.Opus != exact.Opus || p.MusicKey != exact.MusicKey {
			t.Fatal("repair changed metadata", p, err)
		}
		rows, err := s.ListPieces(ctx, owner, ListOptions{Query: "op10 c# minor", Sort: SortTitle})
		if err != nil || len(rows) != 2 {
			t.Fatal("forced refold", rows, err)
		}
	}
	if _, err = s.pool.Exec(ctx, `UPDATE search_index_state SET fold_version=4`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ForceRefoldSearchText(ctx); !errors.Is(err, ErrSearchFoldVersionAhead) {
		t.Fatal("expected recognizable newer fold version error", err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE search_index_state SET fold_version=3`); err != nil {
		t.Fatal(err)
	}
	empty := ""
	cleared, err := s.UpdatePiece(ctx, owner, exact.ID, PiecePatch{Opus: &empty, MusicKey: &empty})
	if err != nil || cleared.Opus != "" || cleared.MusicKey != "" {
		t.Fatal("clear failed", cleared, err)
	}
	rows, err = s.ListPieces(ctx, owner, ListOptions{Query: "op10 c# minor", Sort: SortTitle})
	if err != nil || len(rows) != 1 || rows[0].ID != second.ID {
		t.Fatal("clear left index terms", rows, err)
	}
	// Similar matches can fuzz a name, but never a joined key.
	wrong, err := s.SuggestPieces(ctx, owner, ListOptions{Query: "choppin c# minor"})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range wrong {
		if p.ID != second.ID {
			t.Fatal("wrong key suggested", p)
		}
	}
}
