package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/bitofbytes-io/noted/internal/config"
)

const testPieceID = "4f607127-fb97-4b22-90f5-1b9bec77b739"
const testUserID = "db53bb2a-b720-407a-8941-cd4459f69e79"
const testAllowedOrigin = "https://noted.example.test"

type fakeBackend struct {
	listQuery    string
	listFavorite *bool
	listUserID   string
	listStatuses []string
	listSort     string
	listCalls    int
	summaryCalls int
	summaries    []app.PieceSummary
	createInput  app.PieceInput
	createUserID string
	createErr    error
	patchInput   app.PiecePatch
	patchUserID  string
	patchPieceID string
	pdfFilename  string
	pdfBody      []byte
	pdfError     error
	pdfUserID    string
	pdfPieceID   string
	readerState  app.ReaderState
	readerError  error
	imslpQuery   string
	imslpUserID  string
	imslpErr     error

	preferencesPatch  app.PreferencesPatch
	preferencesUserID string
	preferencesErr    error

	continued      *app.Piece
	continueUserID string
}

func (fake *fakeBackend) ListPieces(_ context.Context, userID string, options app.ListOptions) ([]app.Piece, error) {
	fake.listUserID, fake.listQuery, fake.listFavorite = userID, options.Query, options.Favorite
	fake.listStatuses, fake.listSort = options.Statuses, options.Sort
	fake.listCalls++
	return []app.Piece{}, nil
}
func (fake *fakeBackend) ListPieceSummaries(_ context.Context, userID string, options app.ListOptions) ([]app.PieceSummary, error) {
	fake.listUserID, fake.listQuery, fake.listFavorite = userID, options.Query, options.Favorite
	fake.listStatuses, fake.listSort = options.Statuses, options.Sort
	fake.summaryCalls++
	if fake.summaries == nil {
		return []app.PieceSummary{}, nil
	}
	return fake.summaries, nil
}
func (fake *fakeBackend) ContinuePiece(_ context.Context, userID string) (*app.Piece, error) {
	fake.continueUserID = userID
	return fake.continued, nil
}
func (fake *fakeBackend) GetPreferences(_ context.Context, userID string) (app.Preferences, error) {
	fake.preferencesUserID = userID
	return app.Preferences{LibraryFilter: "current", LibrarySort: "title"}, nil
}
func (fake *fakeBackend) PutPreferences(_ context.Context, userID string, patch app.PreferencesPatch) (app.Preferences, error) {
	fake.preferencesUserID, fake.preferencesPatch = userID, patch
	preferences := app.Preferences{LibraryFilter: "current", LibrarySort: "title"}
	if patch.LibraryFilter != nil {
		preferences.LibraryFilter = *patch.LibraryFilter
	}
	if patch.LibrarySort != nil {
		preferences.LibrarySort = *patch.LibrarySort
	}
	return preferences, fake.preferencesErr
}
func (*fakeBackend) GetPiece(context.Context, string, string) (app.Piece, error) {
	return app.Piece{ID: testPieceID}, nil
}
func (fake *fakeBackend) CreatePiece(_ context.Context, userID string, input app.PieceInput) (app.Piece, error) {
	fake.createUserID, fake.createInput = userID, input
	return app.Piece{ID: testPieceID, ListeningURL: input.ListeningURL}, fake.createErr
}
func (fake *fakeBackend) UpdatePiece(_ context.Context, userID, pieceID string, patch app.PiecePatch) (app.Piece, error) {
	fake.patchUserID, fake.patchPieceID, fake.patchInput = userID, pieceID, patch
	piece := app.Piece{ID: testPieceID}
	if patch.ListeningURL != nil {
		piece.ListeningURL = *patch.ListeningURL
	}
	return piece, nil
}
func (*fakeBackend) DeletePiece(context.Context, string, string) error { return nil }
func (fake *fakeBackend) PDFSource(
	_ context.Context,
	userID, pieceID string,
) (app.PDFSource, assets.ReadSeekCloser, error) {
	fake.pdfUserID, fake.pdfPieceID = userID, pieceID
	if fake.pdfError != nil {
		return app.PDFSource{}, nil, fake.pdfError
	}
	filename := fake.pdfFilename
	if filename == "" {
		filename = "score.pdf"
	}
	body := fake.pdfBody
	if body == nil {
		body = []byte("0123456789")
	}
	reader := &seekReadCloser{Reader: bytes.NewReader(body)}
	return app.PDFSource{OriginalFilename: filename, UploadedAt: time.Unix(1, 0)}, reader, nil
}
func (*fakeBackend) GetReaderState(context.Context, string, string) (app.ReaderState, error) {
	return app.ReaderState{PieceID: testPieceID, PDFChecksumSHA256: strings.Repeat("a", 64), Mode: "page", LastPage: 1, Zoom: 1, ScrollSpeed: 5}, nil
}
func (fake *fakeBackend) PutReaderState(_ context.Context, _, _ string, state app.ReaderState) (app.ReaderState, error) {
	fake.readerState = state
	return state, fake.readerError
}
func (fake *fakeBackend) SearchIMSLP(_ context.Context, userID, query string) (app.IMSLPSearch, error) {
	fake.imslpUserID, fake.imslpQuery = userID, query
	if fake.imslpErr != nil {
		return app.IMSLPSearch{}, fake.imslpErr
	}
	return app.IMSLPSearch{Status: "ready", Results: []app.IMSLPWork{{Title: "Prelude", Composer: "Example, Ada", URL: "https://imslp.org/wiki/Prelude_(Example,_Ada)"}}}, nil
}

func TestIMSLPWorkSearchRequiresValidQueryAndReturnsWork(t *testing.T) {
	fake := &fakeBackend{}
	router := testRouter(fake, 1024)
	for _, path := range []string{"/api/imslp/works", "/api/imslp/works?q=x"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusBadRequest || fake.imslpQuery != "" {
			t.Fatalf("invalid search %s: %d %s", path, response.Code, response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/imslp/works?q=Prelude", nil))
	if response.Code != http.StatusOK || fake.imslpQuery != "Prelude" || fake.imslpUserID != testUserID ||
		!strings.Contains(response.Body.String(), `"status":"ready"`) {
		t.Fatalf("work search: %d %s", response.Code, response.Body.String())
	}
}

func TestIMSLPWorkSearchMapsPerUserLimitTo429(t *testing.T) {
	fake := &fakeBackend{imslpErr: fmt.Errorf("search: %w", app.ErrIMSLPThrottled)}
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/imslp/works?q=Prelude", nil))
	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "1" ||
		!strings.Contains(response.Body.String(), `"status":"throttled"`) ||
		!strings.Contains(response.Body.String(), `"results":[]`) {
		t.Fatalf("throttled search: %d %v %s", response.Code, response.Header(), response.Body.String())
	}
}

// fakeAuthenticator succeeds unless one of its error fields is set, and
// records what the OAuth callback passed it.
type fakeAuthenticator struct {
	ensureDevelopmentUserCalls int

	returnPath string // from ConsumeLoginState; "/" when empty
	consumeErr error
	authErr    error
	sessionErr error

	consumedState string
	identity      *auth.GoogleIdentity
	sessionUserID string
}

func (fake *fakeAuthenticator) EnsureDevelopmentUser(context.Context, string) (app.User, error) {
	fake.ensureDevelopmentUserCalls++
	return app.User{ID: testUserID, Email: "learner@noted.local", DisplayName: "Learner"}, nil
}
func (*fakeAuthenticator) NewLoginState(context.Context, string) (string, error) {
	return "state", nil
}
func (fake *fakeAuthenticator) ConsumeLoginState(_ context.Context, state string) (string, error) {
	fake.consumedState = state
	if fake.returnPath == "" {
		return "/", fake.consumeErr
	}
	return fake.returnPath, fake.consumeErr
}
func (fake *fakeAuthenticator) AuthenticateGoogle(_ context.Context, identity auth.GoogleIdentity) (app.User, error) {
	fake.identity = &identity
	return app.User{ID: testUserID}, fake.authErr
}
func (fake *fakeAuthenticator) NewSession(_ context.Context, userID, _, _ string) (string, time.Time, error) {
	fake.sessionUserID = userID
	return "token", time.Now().Add(time.Hour), fake.sessionErr
}
func (*fakeAuthenticator) ResolveSession(context.Context, string) (app.User, error) {
	return app.User{ID: testUserID}, nil
}
func (*fakeAuthenticator) DeleteSession(context.Context, string) error { return nil }

func testRouter(backend Backend, maxUploadBytes int64) http.Handler {
	return NewRouter(backend, &fakeAuthenticator{}, config.Config{
		AppEnv: "test", AuthMode: "development", DevUserEmail: "learner@noted.local",
		MaxUploadBytes: maxUploadBytes, AllowedOrigin: testAllowedOrigin,
	}, nil)
}

type seekReadCloser struct{ *bytes.Reader }

func (*seekReadCloser) Close() error { return nil }

func TestCORSRejectsStateChangingRequestsFromMismatchedOriginBeforeAuthentication(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{name: "post", method: http.MethodPost, path: "/api/pieces/", body: `{"title":"Prelude"}`},
		{name: "patch", method: http.MethodPatch, path: "/api/pieces/" + testPieceID + "/", body: `{"title":"Prelude"}`},
		{name: "put", method: http.MethodPut, path: "/api/pieces/" + testPieceID + "/reader-state", body: `{}`},
		{name: "delete", method: http.MethodDelete, path: "/api/pieces/" + testPieceID + "/"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fake := &fakeBackend{}
			authenticator := &fakeAuthenticator{}
			router := NewRouter(fake, authenticator, config.Config{
				AppEnv: "test", AuthMode: "development", DevUserEmail: "learner@noted.local",
				MaxUploadBytes: 1024, AllowedOrigin: testAllowedOrigin,
			}, nil)
			request := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
			request.Header.Set("Origin", "https://untrusted.example.test")
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()

			router.ServeHTTP(response, request)

			if response.Code != http.StatusForbidden ||
				response.Body.String() != "{\"error\":\"request origin is not allowed\"}\n" {
				t.Fatalf("unexpected rejection: %d %q", response.Code, response.Body.String())
			}
			if authenticator.ensureDevelopmentUserCalls != 0 {
				t.Fatalf("authentication calls = %d, want 0", authenticator.ensureDevelopmentUserCalls)
			}
			if fake.createUserID != "" || fake.patchUserID != "" {
				t.Fatalf("backend mutation was invoked: create user=%q patch user=%q", fake.createUserID, fake.patchUserID)
			}
			if response.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatalf("untrusted origin was allowed: %q", response.Header().Get("Access-Control-Allow-Origin"))
			}
		})
	}
}

func TestCORSRejectsMultipartMutationFromMismatchedOrigin(t *testing.T) {
	fake := &fakeBackend{}
	authenticator := &fakeAuthenticator{}
	router := NewRouter(fake, authenticator, config.Config{
		AppEnv: "test", AuthMode: "development", DevUserEmail: "learner@noted.local",
		MaxUploadBytes: 1024, AllowedOrigin: testAllowedOrigin,
	}, nil)
	body := &bytes.Buffer{}
	form := multipart.NewWriter(body)
	_ = form.WriteField("revision", "1")
	file, _ := form.CreateFormFile("file", "score.pdf")
	_, _ = io.WriteString(file, "%PDF-safe")
	_ = form.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/imports/"+testPieceID+"/sources", body)
	request.Header.Set("Origin", "https://untrusted.example.test")
	request.Header.Set("Content-Type", form.FormDataContentType())
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", response.Code, response.Body.String())
	}
	if authenticator.ensureDevelopmentUserCalls != 0 {
		t.Fatalf("rejected upload reached authentication: auth=%d",
			authenticator.ensureDevelopmentUserCalls)
	}
}

func TestCORSAllowsConfiguredOriginAndPreflight(t *testing.T) {
	fake := &fakeBackend{}
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/pieces/",
		strings.NewReader(`{"title":"Prelude"}`),
	)
	request.Header.Set("Origin", testAllowedOrigin)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)

	if response.Code != http.StatusCreated || fake.createUserID != testUserID {
		t.Fatalf("configured origin request failed: %d %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Access-Control-Allow-Origin") != testAllowedOrigin ||
		response.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("missing CORS permission headers: %v", response.Header())
	}

	preflight := httptest.NewRequest(http.MethodOptions, "/api/pieces/", nil)
	preflight.Header.Set("Origin", testAllowedOrigin)
	preflight.Header.Set("Access-Control-Request-Method", http.MethodPost)
	preflightResponse := httptest.NewRecorder()
	testRouter(&fakeBackend{}, 1024).ServeHTTP(preflightResponse, preflight)

	if preflightResponse.Code != http.StatusNoContent ||
		preflightResponse.Header().Get("Access-Control-Allow-Origin") != testAllowedOrigin ||
		!strings.Contains(preflightResponse.Header().Get("Access-Control-Allow-Methods"), http.MethodPost) {
		t.Fatalf("configured-origin preflight failed: %d %v", preflightResponse.Code, preflightResponse.Header())
	}
}

func TestCORSDoesNotAuthorizeMismatchedOriginPreflight(t *testing.T) {
	request := httptest.NewRequest(http.MethodOptions, "/api/pieces/", nil)
	request.Header.Set("Origin", "https://untrusted.example.test")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	response := httptest.NewRecorder()
	testRouter(&fakeBackend{}, 1024).ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", response.Code)
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "" ||
		response.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("untrusted preflight was authorized: %v", response.Header())
	}
}

func TestListPassesSearchAndFavoriteFilters(t *testing.T) {
	fake := &fakeBackend{}
	request := httptest.NewRequest(http.MethodGet, "/api/pieces/?q=bach&favorite=true", nil)
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.listQuery != "bach" ||
		fake.listUserID != testUserID || fake.listFavorite == nil || !*fake.listFavorite {
		t.Fatalf("filters not passed: status=%d query=%q favorite=%v", response.Code, fake.listQuery, fake.listFavorite)
	}

	// The service folds the search, so the handler passes it on as typed.
	fake = &fakeBackend{}
	request = httptest.NewRequest(http.MethodGet, "/api/pieces/?q=Dvo%C5%99%C3%A1k+100%25+a_b", nil)
	response = httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.listQuery != "Dvořák 100% a_b" {
		t.Fatalf("search not passed as typed: status=%d query=%q", response.Code, fake.listQuery)
	}
}

func TestListStatusFilter(t *testing.T) {
	for _, test := range []struct {
		path string
		want []string
	}{
		// Absent means Learning and Playing.
		{"/api/pieces/", []string{"learning", "playing"}},
		// A search never hides a Shelved piece.
		{"/api/pieces/?q=bach", nil},
		{"/api/pieces/?q=Fr%C3%A9d%C3%A9ric", nil},
		// Punctuation alone folds to no search at all.
		{"/api/pieces/?q=%25+_", []string{"learning", "playing"}},
		{"/api/pieces/?status=all", nil},
		{"/api/pieces/?status=shelved", []string{"shelved"}},
		// An explicit filter still applies while searching.
		{"/api/pieces/?q=bach&status=learning", []string{"learning"}},
		{"/api/pieces/?status=playing,learning,playing", []string{"playing", "learning"}},
	} {
		fake := &fakeBackend{}
		response := httptest.NewRecorder()
		testRouter(fake, 1024).ServeHTTP(response, httptest.NewRequest(http.MethodGet, test.path, nil))
		if response.Code != http.StatusOK || fmt.Sprint(fake.listStatuses) != fmt.Sprint(test.want) ||
			(test.want == nil) != (fake.listStatuses == nil) {
			t.Fatalf("%s: status=%d statuses=%v, want %v", test.path, response.Code, fake.listStatuses, test.want)
		}
	}
	for _, path := range []string{"/api/pieces/?status=archived", "/api/pieces/?status=learning,"} {
		fake := &fakeBackend{}
		response := httptest.NewRecorder()
		testRouter(fake, 1024).ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusBadRequest || fake.listCalls != 0 {
			t.Fatalf("%s: status=%d calls=%d", path, response.Code, fake.listCalls)
		}
	}
}

func TestListSort(t *testing.T) {
	for path, want := range map[string]string{
		"/api/pieces/":                       "title",
		"/api/pieces/?sort=composer":         "composer",
		"/api/pieces/?sort=recent":           "recent",
		"/api/pieces/?sort=added":            "added",
		"/api/pieces/?q=bach&sort=fresh":     "fresh",
		"/api/pieces/?sort=title&status=all": "title",
	} {
		fake := &fakeBackend{}
		response := httptest.NewRecorder()
		testRouter(fake, 1024).ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || fake.listSort != want {
			t.Fatalf("%s: status=%d sort=%q, want %q", path, response.Code, fake.listSort, want)
		}
	}
	for _, path := range []string{"/api/pieces/?sort=favorite", "/api/pieces/?sort=title%20DESC", "/api/pieces/?sort=Recent"} {
		fake := &fakeBackend{}
		response := httptest.NewRecorder()
		testRouter(fake, 1024).ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusBadRequest || fake.listCalls != 0 ||
			!strings.Contains(response.Body.String(), "sort must be") {
			t.Fatalf("%s: status=%d calls=%d body=%s", path, response.Code, fake.listCalls, response.Body.String())
		}
	}
}

func TestListSummaries(t *testing.T) {
	played := time.Date(2026, 10, 18, 20, 0, 0, 0, time.UTC)
	fake := &fakeBackend{summaries: []app.PieceSummary{{
		ID: testPieceID, Title: "Humoresque", Composer: "Antonín Dvořák", Aliases: "Op. 101",
		Status: "playing", PDF: &app.SummaryPDF{PageCount: 3, ContentURL: "/api/pieces/" + testPieceID + "/pdf"},
		LastPlayedAt: &played, CreatedAt: played.Add(-time.Hour),
		SearchText: "humoresque antonin dvorak op 101 slow and singing",
	}}}
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response,
		httptest.NewRequest(http.MethodGet, "/api/pieces/?fields=summary&status=all", nil))
	want := `[{"id":"` + testPieceID + `","title":"Humoresque","composer":"Antonín Dvořák",` +
		`"aliases":"Op. 101","favorite":false,"status":"playing","listeningUrl":"",` +
		`"pdf":{"pageCount":3,"contentUrl":"/api/pieces/` + testPieceID + `/pdf"},` +
		`"lastPlayedAt":"2026-10-18T20:00:00Z","createdAt":"2026-10-18T19:00:00Z",` +
		`"searchText":"humoresque antonin dvorak op 101 slow and singing"}]` + "\n"
	if response.Code != http.StatusOK || response.Body.String() != want ||
		fake.summaryCalls != 1 || fake.listCalls != 0 || fake.listUserID != testUserID ||
		fake.listStatuses != nil || fake.listSort != "title" {
		t.Fatalf("summaries: %d %s calls=%d/%d statuses=%v sort=%q",
			response.Code, response.Body.String(), fake.summaryCalls, fake.listCalls, fake.listStatuses, fake.listSort)
	}
	// No notes in a summary.
	if strings.Contains(response.Body.String(), "notes") {
		t.Fatalf("summary carries notes: %s", response.Body.String())
	}

	// The filters apply to summaries as to the full list.
	fake = &fakeBackend{}
	response = httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response,
		httptest.NewRequest(http.MethodGet, "/api/pieces/?fields=summary&q=bach&favorite=true&sort=recent", nil))
	if response.Code != http.StatusOK || response.Body.String() != "[]\n" || fake.listQuery != "bach" ||
		fake.listFavorite == nil || !*fake.listFavorite || fake.listSort != "recent" {
		t.Fatalf("filtered summaries: %d %s", response.Code, response.Body.String())
	}

	fake = &fakeBackend{}
	response = httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/pieces/?fields=notes", nil))
	if response.Code != http.StatusBadRequest || fake.listCalls+fake.summaryCalls != 0 ||
		!strings.Contains(response.Body.String(), "fields must be summary") {
		t.Fatalf("unknown fields: %d %s", response.Code, response.Body.String())
	}
}

func TestContinuePieceForTheCurrentUser(t *testing.T) {
	fake := &fakeBackend{}
	router := testRouter(fake, 1024)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/pieces/continue", nil))
	if response.Code != http.StatusOK || fake.continueUserID != testUserID ||
		response.Body.String() != "{\"piece\":null}\n" {
		t.Fatalf("nothing to continue: %d %q user=%q", response.Code, response.Body.String(), fake.continueUserID)
	}

	fake.continued = &app.Piece{ID: testPieceID, Title: "Nocturne"}
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/pieces/continue", nil))
	if response.Code != http.StatusOK ||
		!strings.Contains(response.Body.String(), `"piece":{"id":"`+testPieceID+`","title":"Nocturne"`) {
		t.Fatalf("continue: %d %s", response.Code, response.Body.String())
	}
}

func TestPreferencesReadAndWriteForTheCurrentUser(t *testing.T) {
	fake := &fakeBackend{}
	router := testRouter(fake, 1024)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/account/preferences", nil))
	if response.Code != http.StatusOK || fake.preferencesUserID != testUserID ||
		!strings.Contains(response.Body.String(), `"libraryFilter":"current"`) ||
		!strings.Contains(response.Body.String(), `"librarySort":"title"`) {
		t.Fatalf("get preferences: %d %s", response.Code, response.Body.String())
	}
	request := httptest.NewRequest(http.MethodPut, "/api/account/preferences", strings.NewReader(`{"libraryFilter":"favorites"}`))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.preferencesPatch.LibraryFilter == nil ||
		*fake.preferencesPatch.LibraryFilter != "favorites" || fake.preferencesPatch.LibrarySort != nil ||
		!strings.Contains(response.Body.String(), `"libraryFilter":"favorites"`) {
		t.Fatalf("put preferences: %d %s", response.Code, response.Body.String())
	}
	// Only the sort: the filter is left as it was saved.
	request = httptest.NewRequest(http.MethodPut, "/api/account/preferences", strings.NewReader(`{"librarySort":"composer"}`))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.preferencesPatch.LibraryFilter != nil ||
		fake.preferencesPatch.LibrarySort == nil || *fake.preferencesPatch.LibrarySort != "composer" ||
		!strings.Contains(response.Body.String(), `"librarySort":"composer"`) {
		t.Fatalf("put sort preference: %d %s", response.Code, response.Body.String())
	}
	request = httptest.NewRequest(http.MethodPut, "/api/account/preferences", strings.NewReader(`{"theme":"dark"}`))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown preference: %d %s", response.Code, response.Body.String())
	}
}

func TestCreateAndPatchPassStatus(t *testing.T) {
	fake := &fakeBackend{}
	router := testRouter(fake, 1024)
	request := httptest.NewRequest(http.MethodPost, "/api/pieces/", strings.NewReader(`{"title":"Prelude","status":"learning"}`))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || fake.createInput.Status == nil || *fake.createInput.Status != "learning" {
		t.Fatalf("create: %d %+v", response.Code, fake.createInput)
	}
	request = httptest.NewRequest(http.MethodPatch, "/api/pieces/"+testPieceID+"/", strings.NewReader(`{"status":"shelved"}`))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.patchInput.Status == nil || *fake.patchInput.Status != "shelved" {
		t.Fatalf("patch: %d %+v", response.Code, fake.patchInput)
	}
}

func TestReaderStateChecksumConflictReturns409(t *testing.T) {
	fake := &fakeBackend{readerError: app.ErrPDFChanged}
	checksum := strings.Repeat("a", 64)
	request := httptest.NewRequest(
		http.MethodPut,
		"/api/pieces/"+testPieceID+"/reader-state",
		strings.NewReader(`{"pieceId":"`+testPieceID+`","pdfChecksumSha256":"`+checksum+`","mode":"page","lastPage":2,"scrollPosition":0,"zoom":1,"scrollSpeed":5,"scrollPaused":true}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)

	if response.Code != http.StatusConflict ||
		!strings.Contains(response.Body.String(), "score PDF changed") {
		t.Fatalf("expected PDF conflict, got %d %s", response.Code, response.Body.String())
	}
	if fake.readerState.PDFChecksumSHA256 != checksum || fake.readerState.LastPage != 2 {
		t.Fatalf("reader state checksum was not passed to the backend: %+v", fake.readerState)
	}
}

func TestCreateAndPatchPassListeningURL(t *testing.T) {
	fake := &fakeBackend{}
	createBody := strings.NewReader(`{
		"title":"Prelude","sourceUrl":"https://scores.example.test/prelude",
		"listeningUrl":"https://listen.example.test/prelude"
	}`)
	createRequest := httptest.NewRequest(http.MethodPost, "/api/pieces/", createBody)
	createResponse := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(createResponse, createRequest)
	if createResponse.Code != http.StatusCreated || fake.createUserID != testUserID ||
		fake.createInput.ListeningURL != "https://listen.example.test/prelude" ||
		fake.createInput.SourceURL != "https://scores.example.test/prelude" ||
		!strings.Contains(createResponse.Body.String(), `"listeningUrl":"https://listen.example.test/prelude"`) {
		t.Fatalf("create did not preserve distinct URLs: status=%d input=%+v body=%s",
			createResponse.Code, fake.createInput, createResponse.Body.String())
	}

	patchRequest := httptest.NewRequest(
		http.MethodPatch,
		"/api/pieces/"+testPieceID+"/",
		strings.NewReader(`{"listeningUrl":"https://listen.example.test/revised"}`),
	)
	patchResponse := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(patchResponse, patchRequest)
	if patchResponse.Code != http.StatusOK || fake.patchUserID != testUserID ||
		fake.patchPieceID != testPieceID || fake.patchInput.ListeningURL == nil ||
		*fake.patchInput.ListeningURL != "https://listen.example.test/revised" {
		t.Fatalf("patch did not preserve listening URL: status=%d patch=%+v body=%s",
			patchResponse.Code, fake.patchInput, patchResponse.Body.String())
	}
}

func TestCreateReturnsListeningURLValidationError(t *testing.T) {
	fake := &fakeBackend{createErr: &app.ValidationError{Message: "listening URL must be an http or https URL"}}
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/pieces/",
		strings.NewReader(`{"title":"Prelude","listeningUrl":"file:///tmp/recording.mp3"}`),
	)
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), "listening URL must be an http or https URL") {
		t.Fatalf("expected listening URL validation failure, got %d %s", response.Code, response.Body.String())
	}
}

// A piece's PDF is replaced only through Prepare; the PDF route is read-only.
func TestPDFRouteRejectsDirectUpload(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/pieces/"+testPieceID+"/pdf", strings.NewReader("%PDF-"))
	response := httptest.NewRecorder()
	testRouter(&fakeBackend{}, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("direct PDF upload: %d %s", response.Code, response.Body.String())
	}
}

func TestPDFSupportsRanges(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/pieces/"+testPieceID+"/pdf", nil)
	request.Header.Set("Range", "bytes=2-5")
	response := httptest.NewRecorder()
	testRouter(&fakeBackend{}, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusPartialContent || response.Body.String() != "2345" {
		t.Fatalf("unexpected range response: %d %q", response.Code, response.Body.String())
	}
	if disposition := response.Header().Get("Content-Disposition"); disposition != `inline; filename=score.pdf` {
		t.Fatalf("Content-Disposition = %q, want inline filename", disposition)
	}
	if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "private, max-age=0, must-revalidate" {
		t.Fatalf("Cache-Control = %q", cacheControl)
	}
}

func TestPDFDownloadServesExactBytesAsSafeAttachment(t *testing.T) {
	wantBody := []byte("%PDF-current-score")
	fake := &fakeBackend{pdfFilename: `../../Daniel's cleaned score.pdf`, pdfBody: wantBody}
	request := httptest.NewRequest(http.MethodGet, "/api/pieces/"+testPieceID+"/pdf/download", nil)
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
	if !bytes.Equal(response.Body.Bytes(), wantBody) {
		t.Fatalf("download body = %q, want %q", response.Body.Bytes(), wantBody)
	}
	mediaType, parameters, err := mime.ParseMediaType(response.Header().Get("Content-Disposition"))
	if err != nil {
		t.Fatalf("parse Content-Disposition: %v", err)
	}
	if mediaType != "attachment" || parameters["filename"] != "Daniel's cleaned score.pdf" {
		t.Fatalf("Content-Disposition = %q", response.Header().Get("Content-Disposition"))
	}
	if response.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("Content-Type = %q", response.Header().Get("Content-Type"))
	}
	if response.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("Accept-Ranges = %q", response.Header().Get("Accept-Ranges"))
	}
	if response.Header().Get("Cache-Control") != "private, max-age=0, must-revalidate" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
	if fake.pdfUserID != testUserID || fake.pdfPieceID != testPieceID {
		t.Fatalf("PDFSource called with user=%q piece=%q", fake.pdfUserID, fake.pdfPieceID)
	}
}

func TestPDFDownloadSupportsHead(t *testing.T) {
	request := httptest.NewRequest(http.MethodHead, "/api/pieces/"+testPieceID+"/pdf/download", nil)
	response := httptest.NewRecorder()
	testRouter(&fakeBackend{}, 1024).ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Body.Len() != 0 {
		t.Fatalf("unexpected HEAD response: %d body=%q", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Length") != "10" {
		t.Fatalf("Content-Length = %q, want 10", response.Header().Get("Content-Length"))
	}
	if disposition := response.Header().Get("Content-Disposition"); disposition != `attachment; filename=score.pdf` {
		t.Fatalf("Content-Disposition = %q, want attachment filename", disposition)
	}
}

func TestPDFDownloadReturnsUniformNotFoundForUnavailablePiece(t *testing.T) {
	fake := &fakeBackend{pdfError: app.ErrNotFound}
	request := httptest.NewRequest(http.MethodGet, "/api/pieces/"+testPieceID+"/pdf/download", nil)
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)

	if response.Code != http.StatusNotFound || response.Body.String() != "{\"error\":\"piece not found\"}\n" {
		t.Fatalf("unexpected not-found response: %d %q", response.Code, response.Body.String())
	}
	if fake.pdfUserID != testUserID || fake.pdfPieceID != testPieceID {
		t.Fatalf("PDFSource called with user=%q piece=%q", fake.pdfUserID, fake.pdfPieceID)
	}
}

func TestChangedPieceConflictGuidance(t *testing.T) {
	response := httptest.NewRecorder()
	handleError(response, app.ErrPieceChanged)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "draft is retained") || !strings.Contains(response.Body.String(), "Start a new preparation") || strings.Contains(response.Body.String(), "reload") {
		t.Fatalf("stale piece guidance: %d %s", response.Code, response.Body.String())
	}
}

func TestTooManyPagesIsAValidationError(t *testing.T) {
	response := httptest.NewRecorder()
	handleError(response, app.ErrTooManyPages)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "up to 10 pages") {
		t.Fatalf("page limit response: %d %s", response.Code, response.Body.String())
	}
}

// The status comes from the error's type, never its wording.
func TestValidationStatusFollowsErrorType(t *testing.T) {
	for name, test := range map[string]struct {
		err    error
		status int
		body   string
	}{
		"validation": {&app.ValidationError{Message: "title must be between 1 and 300 characters"}, 400,
			`{"error":"title must be between 1 and 300 characters"}`},
		"wrapped validation": {fmt.Errorf("update draft: %w", &app.ValidationError{Message: "crop must have four normalized edges enclosing an area"}), 400,
			`{"error":"crop must have four normalized edges enclosing an area"}`},
		"library cause stays out": {&app.ValidationError{Message: "PDF must be readable and unencrypted", Cause: errors.New("pdfcpu: xreftable: corrupt object 12 0")}, 400,
			`{"error":"PDF must be readable and unencrypted"}`},
		"wording alone is not validation": {errors.New("database replica must be writable: cannot execute UPDATE"), 500,
			`{"error":"internal server error"}`},
	} {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			handleError(response, test.err)
			if response.Code != test.status || strings.TrimSpace(response.Body.String()) != test.body {
				t.Fatalf("%d %s", response.Code, response.Body.String())
			}
		})
	}
}
