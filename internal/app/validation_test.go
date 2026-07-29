package app

import (
	"strings"
	"testing"
)

func TestValidation(t *testing.T) {
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
	if err := ValidateReaderState(ReaderState{Mode: "scroll", LastPage: 1, Zoom: 1, ScrollSpeed: 32}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateReaderState(ReaderState{Mode: "page", LastPage: 0, Zoom: 1, ScrollSpeed: 32}); err == nil {
		t.Fatal("expected invalid page to fail")
	}
}
