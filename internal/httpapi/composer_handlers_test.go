package httpapi

import (
	"context"
	"github.com/bitofbytes-io/noted/internal/app"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type composerBackend struct {
	*fakeBackend
	owner string
	apply bool
	err   error
}

func (b *composerBackend) ListComposers(_ context.Context, owner string) ([]app.ComposerEntry, error) {
	b.owner = owner
	return []app.ComposerEntry{{Name: "Chopin", Count: 1}}, b.err
}
func (b *composerBackend) PreviewComposerMerge(_ context.Context, owner string, _ app.ComposerMerge) (app.ComposerPreview, error) {
	b.owner = owner
	return app.ComposerPreview{Count: 1, Fingerprint: strings.Repeat("a", 64)}, b.err
}
func (b *composerBackend) MergeComposers(ctx context.Context, owner string, input app.ComposerMerge) (app.ComposerPreview, error) {
	b.apply = true
	return b.PreviewComposerMerge(ctx, owner, input)
}
func TestComposerEndpoints(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPatch} {
		b := &composerBackend{fakeBackend: &fakeBackend{}}
		path := "/api/composers/"
		if method == http.MethodPost {
			path += "preview"
		}
		req := httptest.NewRequest(method, path, strings.NewReader(`{"spellings":["Chopin"],"target":"Frédéric Chopin"}`))
		req.Header.Set("Content-Type", "application/json")
		response := serve(testRouter(b, 1024), req)
		if response.Code != 200 || b.owner != testUserID || b.apply != (method == http.MethodPatch) {
			t.Fatal(method, response.Code, response.Body.String())
		}
	}
	b := &composerBackend{fakeBackend: &fakeBackend{}, err: app.ErrComposerChanged}
	req := httptest.NewRequest(http.MethodPatch, "/api/composers/", strings.NewReader(`{"spellings":["Chopin"],"target":"Chopin"}`))
	req.Header.Set("Content-Type", "application/json")
	if r := serve(testRouter(b, 1024), req); r.Code != 409 {
		t.Fatal("stale preview", r.Code)
	}
	for _, body := range []string{`{`, `{"target":"Chopin","unexpected":true}`} {
		req := httptest.NewRequest(http.MethodPost, "/api/composers/preview", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if r := serve(testRouter(b, 1024), req); r.Code != 400 {
			t.Fatal("malformed input", r.Code)
		}
	}
}

func TestComposerEndpointsRejectAnonymousAndShortcutBearer(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPatch} {
		for _, bearer := range []string{"", "Bearer synthetic-shortcut"} {
			backend := &composerBackend{fakeBackend: &fakeBackend{}}
			router := shortcutRouter(backend, &fakeAuthenticator{}, "google", 1024)
			path := "/api/composers/"
			if method == http.MethodPost {
				path += "preview"
			}
			request := httptest.NewRequest(method, path, strings.NewReader(`{}`))
			request.Header.Set("Authorization", bearer)
			request.Header.Set("Content-Type", "application/json")
			if response := serve(router, request); response.Code != 401 || backend.owner != "" {
				t.Fatal("composer endpoint accepted non-session access", method, response.Code)
			}
		}
	}
}
