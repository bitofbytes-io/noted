package app

import (
	"errors"
	"strings"
	"testing"
)

func TestValidation(t *testing.T) {
	checksum := strings.Repeat("a", 64)
	validated, err := validatePiece(PieceInput{
		Title: "  Prelude ", SourceURL: "https://example.test/score",
		ListeningURL: "  https://www.youtube.com/watch?v=recording  ",
	})
	if err != nil {
		t.Fatal(err)
	}
	if validated.Title != "Prelude" || validated.ListeningURL != "https://www.youtube.com/watch?v=recording" {
		t.Fatalf("piece fields were not trimmed: %+v", validated)
	}
	if _, err := validatePiece(PieceInput{Title: "Piece"}); err != nil {
		t.Fatalf("empty listening URL should be valid: %v", err)
	}
	if _, err := validatePiece(PieceInput{Title: "Piece", SourceURL: "file:///etc/passwd"}); err == nil {
		t.Fatal("expected unsafe source URL to fail")
	}
	for _, listeningURL := range []string{
		"youtube.com/watch?v=recording",
		"file:///tmp/recording.mp3",
		"https://:443/recording",
	} {
		if _, err := validatePiece(PieceInput{Title: "Piece", ListeningURL: listeningURL}); err == nil ||
			err.Error() != "listening URL must be an http or https URL" {
			t.Fatalf("listening URL %q validation error = %v", listeningURL, err)
		}
	}
	if _, err := validatePiece(PieceInput{
		Title: "Piece", ListeningURL: "https://example.test/" + strings.Repeat("a", 2000),
	}); err == nil || err.Error() != "listening URL must be at most 2000 characters" {
		t.Fatalf("oversized listening URL validation error = %v", err)
	}
	shelved, archived, empty := "shelved", "archived", ""
	if piece, err := validatePiece(PieceInput{Title: "Piece", Status: &shelved}); err != nil || *piece.Status != "shelved" {
		t.Fatalf("shelved status: %+v %v", piece, err)
	}
	if piece, err := validatePiece(PieceInput{Title: "Piece"}); err != nil || piece.Status != nil {
		t.Fatalf("absent status should stay absent for the caller to default: %+v %v", piece, err)
	}
	for _, status := range []*string{&archived, &empty} {
		if _, err := validatePiece(PieceInput{Title: "Piece", Status: status}); err == nil {
			t.Fatalf("expected status %q to fail", *status)
		}
	}
	for _, filter := range []string{"current", "all", "favorites", "learning", "playing", "shelved"} {
		if err := validatePreferences(PreferencesPatch{LibraryFilter: &filter}); err != nil {
			t.Fatalf("library filter %q: %v", filter, err)
		}
	}
	for _, filter := range []string{"", "Favorites", "learning,playing"} {
		if err := validatePreferences(PreferencesPatch{LibraryFilter: &filter}); err == nil {
			t.Fatalf("expected library filter %q to fail", filter)
		}
	}
	for _, sort := range []string{"title", "composer", "recent", "added", "fresh"} {
		if err := validatePreferences(PreferencesPatch{LibrarySort: &sort}); err != nil {
			t.Fatalf("library sort %q: %v", sort, err)
		}
		if parsed, err := ParseSort(sort); err != nil || parsed != sort {
			t.Fatalf("sort=%s parsed as %q, %v", sort, parsed, err)
		}
	}
	for _, sort := range []string{"", "Title", "played", "title,composer"} {
		if err := validatePreferences(PreferencesPatch{LibrarySort: &sort}); err == nil {
			t.Fatalf("expected library sort %q to fail", sort)
		}
	}
	if err := validatePreferences(PreferencesPatch{}); err != nil {
		t.Fatalf("an empty patch changes nothing: %v", err)
	}
	if parsed, err := ParseSort(" "); err != nil || parsed != SortTitle {
		t.Fatalf("absent sort parsed as %q, %v", parsed, err)
	}
	var validationError *ValidationError
	if _, err := ParseSort("favorite DESC"); !errors.As(err, &validationError) {
		t.Fatalf("unknown sort error = %v, want a ValidationError", err)
	}
	if err := ValidateReaderState(ReaderState{PDFChecksumSHA256: checksum, Mode: "scroll", LastPage: 1, Zoom: 1, ScrollSpeed: 5}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateReaderState(ReaderState{PDFChecksumSHA256: checksum, Mode: "page", LastPage: 0, Zoom: 1, ScrollSpeed: 5}); err == nil {
		t.Fatal("expected invalid page to fail")
	}
	for _, speed := range []float64{0.9, 10.1} {
		if err := ValidateReaderState(ReaderState{PDFChecksumSHA256: checksum, Mode: "scroll", LastPage: 1, Zoom: 1, ScrollSpeed: speed}); err == nil {
			t.Fatalf("expected scroll speed %v to fail", speed)
		}
	}
	if err := ValidateReaderState(ReaderState{PDFChecksumSHA256: "not-a-checksum", Mode: "page", LastPage: 1, Zoom: 1, ScrollSpeed: 5}); err == nil {
		t.Fatal("expected invalid PDF checksum to fail")
	}
}
