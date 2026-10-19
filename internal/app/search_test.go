package app

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

// The web app's fold reads the same vectors (web/src/app/core/search.spec.ts).
func TestFoldSearchVectors(t *testing.T) {
	data, err := os.ReadFile("../../testdata/search-fold-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct{ Input, Folded, Terms, Indexed string }
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) == 0 {
		t.Fatal("no fold vectors")
	}
	for _, vector := range vectors {
		if got := foldSearch(vector.Input); got != vector.Folded {
			t.Errorf("foldSearch(%q) = %q, want %q", vector.Input, got, vector.Folded)
		}
		if got := strings.Join(searchTerms(vector.Input), " "); got != vector.Terms {
			t.Errorf("searchTerms(%q) = %q, want %q", vector.Input, got, vector.Terms)
		}
		if got := searchIndex(vector.Input); got != vector.Indexed {
			t.Errorf("searchIndex(%q) = %q, want %q", vector.Input, got, vector.Indexed)
		}
	}
}

func TestSearchTerms(t *testing.T) {
	for query, want := range map[string][]string{
		"chopin nocturne": {"chopin", "nocturne"},
		"  Dvořák  ":      {"dvorak"},
		"Op.28/4":         {"op28", "4"},
		"op 28 no":        {"op28", "no"},
		"op 28 no 4":      {"op28", "no4"},
		"%":               {},
		"":                {},
	} {
		if got := searchTerms(query); !slices.Equal(got, want) {
			t.Errorf("searchTerms(%q) = %q, want %q", query, got, want)
		}
	}
}

// However a catalogue number or key is typed, every word of the search is in
// the piece's stored text, however that was typed.
func TestSearchTermsMatchAcrossSpellings(t *testing.T) {
	for _, group := range [][]string{
		{"Prelude Op. 28 No. 4", "op 28 no 4", "op28/4", "Op.28 Nr.4", "opus 28 4", "op28 no4"},
		{"Prelude Op.28/4", "op 28 no 4", "op28/4", "Op.28 Nr.4", "opus 28 4", "op28 no4"},
		// A year after an opus still matches a digit at a time.
		{"Études, Op. 10 (1833)", "op 10 1", "op 10 18", "op 10 183", "op 10 1833"},
		{"WTC I Prelude BWV 846", "bwv846", "BWV 846", "bwv 846"},
		{"Sonata K. 545", "k545", "KV 545", "kv545", "K.545"},
		{"Sonata Hob. XVI:52", "hob xvi 52", "hobxvi52", "Hob.XVI/52"},
		{"Impromptu D. 899", "d899", "D 899"},
		{"Nocturne in C# minor", "c# minor", "C♯ minor", "c-sharp minor", "cis-moll", "Cis-Moll"},
		{"Nocturne in cis-Moll", "c# minor", "c sharp minor", "cis moll"},
		{"Polonaise in A♭ major", "ab major", "as-dur", "a flat major"},
	} {
		index := " " + searchIndex(group[0])
		for _, query := range group[1:] {
			for _, term := range searchTerms(query) {
				if !strings.Contains(index, term) {
					t.Errorf("%q: term %q of %q not in %q", group[0], term, query, index)
				}
			}
		}
	}
}

func TestLikeEscape(t *testing.T) {
	for value, want := range map[string]string{
		"100%":   `100\%`,
		"a_b":    `a\_b`,
		`a\b`:    `a\\b`,
		`%_\`:    `\%\_\\`,
		"chopin": "chopin",
	} {
		if got := likeEscape(value); got != want {
			t.Errorf("likeEscape(%q) = %q, want %q", value, got, want)
		}
	}
}

func TestSearchTextCoversTitleComposerAliasesAndNotes(t *testing.T) {
	input, err := validatePiece(PieceInput{
		Title: " Piano Sonata No. 14 ", Composer: "Ludwig van Beethoven",
		Aliases: "  Moonlight Sonata ", Notes: "Adagio sostenuto first",
	})
	if err != nil {
		t.Fatal(err)
	}
	if input.Aliases != "Moonlight Sonata" {
		t.Fatalf("aliases not trimmed: %q", input.Aliases)
	}
	want := "piano sonata no 14 ludwig van beethoven moonlight sonata adagio sostenuto first no14"
	if got := searchText(input); got != want {
		t.Fatalf("searchText = %q, want %q", got, want)
	}
}
