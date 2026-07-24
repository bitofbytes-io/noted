package app

import "testing"

func TestValidation(t *testing.T) {
	if _, err := validatePiece(PieceInput{Title: "  Prelude ", SourceURL: "https://example.test/score"}); err != nil {
		t.Fatal(err)
	}
	if _, err := validatePiece(PieceInput{Title: "Piece", SourceURL: "file:///etc/passwd"}); err == nil {
		t.Fatal("expected unsafe source URL to fail")
	}
	if err := ValidateReaderState(ReaderState{Mode: "scroll", LastPage: 1, Zoom: 1, ScrollSpeed: 32}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateReaderState(ReaderState{Mode: "page", LastPage: 0, Zoom: 1, ScrollSpeed: 32}); err == nil {
		t.Fatal("expected invalid page to fail")
	}
}
