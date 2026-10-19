package app

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

// The web app's fold reads the same vectors (web/src/app/core/search.spec.ts).
func TestFoldSearchVectors(t *testing.T) {
	data, err := os.ReadFile("../../testdata/search-fold-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct{ Input, Folded string }
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
	}
}

func TestSearchTokens(t *testing.T) {
	for query, want := range map[string][]string{
		"chopin nocturne": {"chopin", "nocturne"},
		"  Dvořák  ":      {"dvorak"},
		"Op.28/4":         {"op", "28", "4"},
		"%":               nil,
		"":                nil,
	} {
		if got := searchTokens(query); !slices.Equal(got, want) {
			t.Errorf("searchTokens(%q) = %q, want %q", query, got, want)
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
	want := "piano sonata no 14 ludwig van beethoven moonlight sonata adagio sostenuto first"
	if got := searchText(input); got != want {
		t.Fatalf("searchText = %q, want %q", got, want)
	}
}
