package app

import (
	"fmt"
	"net/url"
	"strings"
)

func validatePiece(input PieceInput) (PieceInput, error) {
	input.Title = strings.TrimSpace(input.Title)
	input.Composer = strings.TrimSpace(input.Composer)
	input.SourceURL = strings.TrimSpace(input.SourceURL)
	input.ListeningURL = strings.TrimSpace(input.ListeningURL)
	input.Notes = strings.TrimSpace(input.Notes)
	if input.Title == "" || len(input.Title) > 300 {
		return input, fmt.Errorf("title must be between 1 and 300 characters")
	}
	if len(input.Composer) > 300 {
		return input, fmt.Errorf("composer must be at most 300 characters")
	}
	if err := validateOptionalURL("source URL", input.SourceURL); err != nil {
		return input, err
	}
	if err := validateOptionalURL("listening URL", input.ListeningURL); err != nil {
		return input, err
	}
	if len(input.Notes) > 10000 {
		return input, fmt.Errorf("notes must be at most 10000 characters")
	}
	return input, nil
}

func validateOptionalURL(label, value string) error {
	if len(value) > 2000 {
		return fmt.Errorf("%s must be at most 2000 characters", label)
	}
	if value == "" {
		return nil
	}
	parsed, err := url.ParseRequestURI(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return fmt.Errorf("%s must be an http or https URL", label)
	}
	return nil
}

func ValidateReaderState(state ReaderState) error {
	if state.Mode != "page" && state.Mode != "scroll" {
		return fmt.Errorf("mode must be page or scroll")
	}
	if state.LastPage < 1 {
		return fmt.Errorf("last page must be at least 1")
	}
	if state.ScrollPosition < 0 {
		return fmt.Errorf("scroll position cannot be negative")
	}
	if state.Zoom < 0.5 || state.Zoom > 2.5 {
		return fmt.Errorf("zoom must be between 0.5 and 2.5")
	}
	if state.ScrollSpeed < 5 || state.ScrollSpeed > 120 {
		return fmt.Errorf("scroll speed must be between 5 and 120")
	}
	return nil
}
