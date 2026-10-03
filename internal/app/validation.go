package app

import (
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
)

// ValidationError is a request the user can correct. Its message goes to the
// client as is, so it never carries a library's wording; Cause, when set, is
// for the server log only.
type ValidationError struct {
	Message string
	Cause   error
}

func (e *ValidationError) Error() string { return e.Message }
func (e *ValidationError) Unwrap() error { return e.Cause }

// invalid returns a ValidationError with a formatted message.
func invalid(format string, args ...any) error {
	return &ValidationError{Message: fmt.Sprintf(format, args...)}
}

func validatePiece(input PieceInput) (PieceInput, error) {
	input.Title = strings.TrimSpace(input.Title)
	input.Composer = strings.TrimSpace(input.Composer)
	input.SourceURL = strings.TrimSpace(input.SourceURL)
	input.ListeningURL = strings.TrimSpace(input.ListeningURL)
	input.Notes = strings.TrimSpace(input.Notes)
	if input.Title == "" || len(input.Title) > 300 {
		return input, invalid("title must be between 1 and 300 characters")
	}
	if len(input.Composer) > 300 {
		return input, invalid("composer must be at most 300 characters")
	}
	if err := validateOptionalURL("source URL", input.SourceURL); err != nil {
		return input, err
	}
	if err := validateOptionalURL("listening URL", input.ListeningURL); err != nil {
		return input, err
	}
	if len(input.Notes) > 10000 {
		return input, invalid("notes must be at most 10000 characters")
	}
	return input, nil
}

func validateOptionalURL(label, value string) error {
	if len(value) > 2000 {
		return invalid("%s must be at most 2000 characters", label)
	}
	if value == "" {
		return nil
	}
	parsed, err := url.ParseRequestURI(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return invalid("%s must be an http or https URL", label)
	}
	return nil
}

func ValidateReaderState(state ReaderState) error {
	checksum, err := hex.DecodeString(state.PDFChecksumSHA256)
	if err != nil || len(checksum) != 32 {
		return invalid("PDF checksum must be a SHA-256 checksum")
	}
	if state.Mode != "page" && state.Mode != "scroll" {
		return invalid("mode must be page or scroll")
	}
	if state.LastPage < 1 {
		return invalid("last page must be at least 1")
	}
	if state.ScrollPosition < 0 {
		return invalid("scroll position cannot be negative")
	}
	if state.Zoom < 0.5 || state.Zoom > 2.5 {
		return invalid("zoom must be between 0.5 and 2.5")
	}
	if state.ScrollSpeed < 1 || state.ScrollSpeed > 10 {
		return invalid("scroll speed must be between 1 and 10")
	}
	return nil
}
