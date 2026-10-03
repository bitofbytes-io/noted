package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// The limit the Service is built with, not a copy of its numbers: the iOS
// Shortcut depends on it.
func TestShortcutImportLimitIsTenAMinutePerUser(t *testing.T) {
	clock := newFakeClock()
	s := NewService(nil, nil)
	limiter := s.shortcuts
	limiter.now = clock.Now
	for i := range 10 {
		if !s.AllowShortcutImport("user-a") {
			t.Fatalf("import %d in a burst was refused", i+1)
		}
	}
	if s.AllowShortcutImport("user-a") {
		t.Fatal("eleventh import in a minute was allowed")
	}
	if !s.AllowShortcutImport("user-b") {
		t.Fatal("another user was limited")
	}
	clock.Advance(6 * time.Second)
	if !s.AllowShortcutImport("user-a") || s.AllowShortcutImport("user-a") {
		t.Fatal("the limit did not refill one import every six seconds")
	}
	clock.Advance(10 * time.Minute)
	s.AllowShortcutImport("user-a")
	limiter.mu.Lock()
	_, kept := limiter.users["user-b"]
	limiter.mu.Unlock()
	if kept {
		t.Fatal("idle user limiter was not expired")
	}
}

func TestShortcutImportRefusesNonPDFBeforeAnyLookup(t *testing.T) {
	s := NewService(nil, nil, 64)
	for name, body := range map[string]string{
		"image": "\xff\xd8\xff\xe0 JPEG", "text": "not a pdf", "empty": "",
	} {
		if _, err := s.ShortcutImport(context.Background(), "user-a", "IMSLP01240-x.pdf", strings.NewReader(body)); !errors.Is(err, ErrNotPDF) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := s.ShortcutImport(context.Background(), "user-a", "x.pdf", strings.NewReader("%PDF-"+strings.Repeat("x", 64))); !errors.Is(err, ErrImportLimit) {
		t.Errorf("oversize: %v", err)
	}
}

func TestShortcutResultNotification(t *testing.T) {
	draft := func(title, composer string) ImportDraft {
		return ImportDraft{ID: "d1", Metadata: PieceInput{Title: title, Composer: composer}}
	}
	for _, test := range []struct {
		draft             ImportDraft
		headline, message string
	}{
		{draft("Clair de lune", "Debussy, Claude"), "Clair de lune — Debussy, Claude", "New draft created."},
		{draft("Bach - Prelude", ""), "Bach - Prelude", "New draft created."},
		{draft("", ""), "Untitled score", "New draft created."},
	} {
		got := shortcutResult(test.draft, "score.pdf")
		if got.Headline != test.headline || got.Message != test.message || got.DraftPath != "/prepare/d1" {
			t.Errorf("%+v → %q / %q", test.draft.Metadata, got.Headline, got.Message)
		}
	}
}
