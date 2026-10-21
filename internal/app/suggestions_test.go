package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestSuggestionBoundsAndLimiter(t *testing.T) {
	s := NewService(nil, nil)
	for _, q := range []string{"", "a", "12345", "op28", "%_", "c# minor", "Eb", "c#"} {
		p, err := s.SuggestPieces(context.Background(), "owner", ListOptions{Query: q})
		if err != nil || len(p) != 0 {
			t.Fatal(q, p, err)
		}
	}
	for _, q := range []string{strings.Repeat("a", 201), strings.Repeat("word ", 9), string([]byte{0xff})} {
		if _, err := s.SuggestPieces(context.Background(), "owner", ListOptions{Query: q}); err == nil {
			t.Fatal("invalid query accepted")
		}
	}
	now := time.Unix(100, 0)
	s.suggestions = newUserLimiter(4, 8, time.Minute, func() time.Time { return now })
	for range 8 {
		if !s.suggestions.allow("owner") {
			t.Fatal("burst exhausted early")
		}
	}
	if _, err := s.SuggestPieces(context.Background(), "owner", ListOptions{Query: "chopin"}); !errors.Is(err, ErrSuggestionsThrottled) {
		t.Fatal("missing throttle", err)
	}
	if !s.suggestions.allow("other") {
		t.Fatal("cross-user throttle")
	}
	now = now.Add(250 * time.Millisecond)
	if !s.suggestions.allow("owner") {
		t.Fatal("no token refill")
	}
	for _, term := range []string{"abc", "op281", "1234", "bwv", "csharpminor", "eflatmajor", "bminor", "csharp"} {
		if fuzzyTerm(term) {
			t.Fatal("short/catalogue token became fuzzy", term)
		}
	}
}
