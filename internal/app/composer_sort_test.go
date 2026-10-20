package app

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

// The web app's composerSurname reads the same vectors
// (web/src/app/features/library/library.utils.spec.ts).
func TestComposerSurnameVectors(t *testing.T) {
	data, err := os.ReadFile("../../testdata/composer-surname-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct{ Composer, Surname string }
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) == 0 {
		t.Fatal("no composer surname vectors")
	}
	for _, vector := range vectors {
		if got := composerSurname(vector.Composer); got != vector.Surname {
			t.Errorf("composerSurname(%q) = %q, want %q", vector.Composer, got, vector.Surname)
		}
	}
}

func TestSortByComposer(t *testing.T) {
	// Already in title order, as ListPieces reads them.
	pieces := []Piece{
		{Title: "Arabesque No. 1", Composer: "Claude Debussy"},
		{Title: "Clair de lune", Composer: "Claude Debussy"},
		{Title: "Exercise", Composer: ""},
		{Title: "Goldberg Variations", Composer: "Johann Sebastian Bach"},
		{Title: "Humoresque", Composer: "antonín dvořák"},
		{Title: "Maple Leaf Rag", Composer: "Scott Joplin"},
		{Title: "Nocturne Op. 9 No. 2", Composer: "Frédéric Chopin"},
		{Title: "Prelude in C major", Composer: "Bach, Johann Sebastian"},
		{Title: "Solfeggietto", Composer: "C. P. E. Bach"},
		{Title: "Ännchen", Composer: "Émile Waldteufel"},
	}
	sortByComposer(pieces, func(piece Piece) string { return piece.Composer })
	got := []string{}
	for _, piece := range pieces {
		got = append(got, piece.Title)
	}
	want := []string{
		// C. P. E. before J. S., and the comma form files with its surname.
		"Prelude in C major", "Solfeggietto", "Goldberg Variations",
		"Nocturne Op. 9 No. 2",
		// Same composer: title order is kept.
		"Arabesque No. 1", "Clair de lune",
		// Accents and case do not move Dvořák away from D.
		"Humoresque",
		"Maple Leaf Rag",
		"Ännchen",
		// No composer goes last.
		"Exercise",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("composer order\n got %q\nwant %q", got, want)
	}
}

func TestComposerSortKeyVectors(t *testing.T) {
	data, err := os.ReadFile("../../testdata/composer-key-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct{ Composer, Key string }
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		if got := composerSortKey(v.Composer); got != v.Key {
			t.Errorf("composerSortKey(%q)=%q want %q", v.Composer, got, v.Key)
		}
	}
}
