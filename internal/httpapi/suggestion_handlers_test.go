package httpapi

import (
	"context"
	"github.com/bitofbytes-io/noted/internal/app"
	"net/http"
	"net/http/httptest"
	"testing"
)

type suggestionBackend struct {
	*fakeBackend
	owner   string
	options app.ListOptions
	err     error
}

func (b *suggestionBackend) SuggestPieces(_ context.Context, owner string, o app.ListOptions) ([]app.PieceSummary, error) {
	b.owner = owner
	b.options = o
	return []app.PieceSummary{}, b.err
}
func TestSuggestionEndpoint(t *testing.T) {
	b := &suggestionBackend{fakeBackend: &fakeBackend{}}
	r := serve(testRouter(b, 1024), httptest.NewRequest("GET", "/api/library/suggestions?q=rachmaninov&favorite=true", nil))
	if r.Code != 200 || b.owner != testUserID || b.options.Favorite == nil || !*b.options.Favorite || b.options.Statuses != nil {
		t.Fatal("owner/search filter", r.Code, b.options)
	}
	for _, query := range []string{"status=invalid", "favorite=invalid"} {
		if r := serve(testRouter(b, 1024), httptest.NewRequest("GET", "/api/library/suggestions?"+query, nil)); r.Code != 400 {
			t.Fatal("invalid options", r.Code)
		}
	}
	b.err = app.ErrSuggestionsThrottled
	r = serve(testRouter(b, 1024), httptest.NewRequest("GET", "/api/library/suggestions?q=chopin", nil))
	if r.Code != 429 || r.Header().Get("Retry-After") != "1" {
		t.Fatal("retryable throttle", r.Code)
	}
	b.err = context.DeadlineExceeded
	if r := serve(testRouter(b, 1024), httptest.NewRequest("GET", "/api/library/suggestions?q=chopin", nil)); r.Code != 503 {
		t.Fatal("timeout", r.Code)
	}
	for _, bearer := range []string{"", "Bearer synthetic-shortcut"} {
		b := &suggestionBackend{fakeBackend: &fakeBackend{}}
		router := shortcutRouter(b, &fakeAuthenticator{}, "google", 1024)
		request := httptest.NewRequest(http.MethodGet, "/api/library/suggestions?q=chopin", nil)
		request.Header.Set("Authorization", bearer)
		if r := serve(router, request); r.Code != 401 || b.owner != "" {
			t.Fatal("non-session access", r.Code)
		}
	}
}
