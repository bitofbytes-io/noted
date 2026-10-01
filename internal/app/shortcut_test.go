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
