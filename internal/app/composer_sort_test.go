package app

import (
	"slices"
	"testing"
)

func TestComposerSurname(t *testing.T) {
	for composer, want := range map[string]string{
		"Johann Sebastian Bach":                    "Bach",
		"  J. S. Bach ":                            "Bach",
		"Ludwig van Beethoven":                     "Beethoven",
		"Claude Debussy":                           "Debussy",
		"Bach, Johann Sebastian":                   "Bach",
		"Vaughan Williams, Ralph":                  "Vaughan Williams",
		"Harry Connick, Jr.":                       "Connick",
		"Martin Luther King Jr":                    "King",
		"Richard Rodgers and Oscar Hammerstein II": "Rodgers",
		"Lennon/McCartney":                         "Lennon",
		"Bach / Gounod":                            "Bach",
		"Franz Liszt (arr. Busoni)":                "Liszt",
		"Antonín Dvořák":                           "Dvořák",
		"Satie":                                    "Satie",
		"Traditional":                              "Traditional",
		"":                                         "",
		"   ":                                      "",
		"(anon.)":                                  "",
	} {
		if got := composerSurname(composer); got != want {
			t.Errorf("composerSurname(%q) = %q, want %q", composer, got, want)
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
	sortByComposer(pieces)
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
