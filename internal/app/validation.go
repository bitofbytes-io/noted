package app

import (
	"encoding/hex"
	"fmt"
	"net/url"
	"slices"
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
	input.Aliases = strings.TrimSpace(input.Aliases)
	if len(input.Aliases) > 1000 {
		return input, invalid("aliases must be at most 1000 characters")
	}
	// Absent in import draft metadata; CreatePiece defaults it to playing.
	if input.Status != nil && !validStatus(*input.Status) {
		return input, invalid("status must be learning, playing or shelved")
	}
	return input, nil
}

// searchText is what library search matches for a validated piece.
func searchText(input PieceInput) string {
	return foldSearch(input.Title + " " + input.Composer + " " + input.Aliases + " " + input.Notes)
}

func validStatus(status string) bool {
	return status == StatusLearning || status == StatusPlaying || status == StatusShelved
}

// ParseStatusFilter reads the library's status= parameter: a comma-separated
// list of statuses, or all. Absent means Learning and Playing, except that a
// search never hides a Shelved piece. A nil result means every status.
func ParseStatusFilter(value, query string) ([]string, error) {
	value = strings.TrimSpace(value)
	switch {
	case value == "" && len(searchTokens(query)) > 0:
		return nil, nil
	case value == "":
		return []string{StatusLearning, StatusPlaying}, nil
	case value == "all":
		return nil, nil
	}
	statuses := []string{}
	for _, status := range strings.Split(value, ",") {
		status = strings.TrimSpace(status)
		if !validStatus(status) {
			return nil, invalid("status must be all or a comma-separated list of learning, playing and shelved")
		}
		if !slices.Contains(statuses, status) {
			statuses = append(statuses, status)
		}
	}
	return statuses, nil
}

// ParseSort reads the library's sort= parameter. Absent means title.
func ParseSort(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return SortTitle, nil
	}
	if !validSort(value) {
		return "", invalid("sort must be title, composer, recent, added or fresh")
	}
	return value, nil
}

func validSort(sort string) bool {
	switch sort {
	case SortTitle, SortComposer, SortRecent, SortAdded, SortFresh:
		return true
	}
	return false
}

func validatePreferences(patch PreferencesPatch) error {
	if patch.LibraryFilter != nil {
		switch *patch.LibraryFilter {
		case "current", "all", "favorites", StatusLearning, StatusPlaying, StatusShelved:
		default:
			return invalid("library filter must be current, all, favorites, learning, playing or shelved")
		}
	}
	if patch.LibrarySort != nil && !validSort(*patch.LibrarySort) {
		return invalid("library sort must be title, composer, recent, added or fresh")
	}
	return nil
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
