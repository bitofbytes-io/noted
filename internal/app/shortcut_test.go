package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestShortcutImportLimitIsTenAMinutePerUser(t *testing.T) {
	clock := newFakeClock()
	limiter := newUserLimiter(10.0/60, 10, 10*time.Minute, clock.Now)
	for i := range 10 {
		if !limiter.allow("user-a") {
			t.Fatalf("import %d in a burst was refused", i+1)
		}
	}
	if limiter.allow("user-a") {
		t.Fatal("eleventh import in a minute was allowed")
	}
	if !limiter.allow("user-b") {
		t.Fatal("another user was limited")
	}
	clock.Advance(6 * time.Second)
	if !limiter.allow("user-a") || limiter.allow("user-a") {
		t.Fatal("the limit did not refill one import every six seconds")
	}
	clock.Advance(10 * time.Minute)
	limiter.allow("user-a")
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
		matched           bool
		headline, message string
	}{
		{draft("Clair de lune", "Debussy, Claude"), true, "Clair de lune — Debussy, Claude", "Added to the waiting draft."},
		{draft("Bach - Prelude", ""), false, "Bach - Prelude", "New draft created."},
		{draft("", ""), false, "Untitled score", "New draft created."},
	} {
		got := shortcutResult(test.draft, "score.pdf", test.matched)
		if got.Headline != test.headline || got.Message != test.message || got.DraftPath != "/prepare/d1" {
			t.Errorf("%+v → %q / %q", test.draft.Metadata, got.Headline, got.Message)
		}
	}
}
