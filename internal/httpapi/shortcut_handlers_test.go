package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/bitofbytes-io/noted/internal/config"
)

// fakeShortcutAuth keeps shortcut tokens as their hashes, as the database does.
type fakeShortcutAuth struct {
	fakeAuthenticator
	mu       sync.Mutex
	user     app.User
	hash     *[32]byte
	created  time.Time
	lastUsed *time.Time
	resolves int
}

func newFakeShortcutAuth() *fakeShortcutAuth {
	return &fakeShortcutAuth{user: app.User{ID: testUserID, Email: "learner@noted.local", DisplayName: "Learner"}}
}

func (fake *fakeShortcutAuth) ShortcutTokenStatus(_ context.Context, userID string) (auth.ShortcutTokenStatus, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if userID != fake.user.ID || fake.hash == nil {
		return auth.ShortcutTokenStatus{}, nil
	}
	created := fake.created
	return auth.ShortcutTokenStatus{Active: true, CreatedAt: &created, LastUsedAt: fake.lastUsed}, nil
}
func (fake *fakeShortcutAuth) CreateShortcutToken(_ context.Context, userID string) (string, time.Time, error) {
	buffer := make([]byte, 32)
	_, _ = rand.Read(buffer)
	token := base64.RawURLEncoding.EncodeToString(buffer)
	hash := sha256.Sum256([]byte(token))
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if userID != fake.user.ID {
		return "", time.Time{}, errors.New("unexpected user")
	}
	fake.hash, fake.created, fake.lastUsed = &hash, time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC), nil
	return token, fake.created, nil
}
func (fake *fakeShortcutAuth) DeleteShortcutToken(context.Context, string) error {
	fake.mu.Lock()
	fake.hash = nil
	fake.mu.Unlock()
	return nil
}
func (fake *fakeShortcutAuth) ResolveShortcutToken(_ context.Context, token string) (app.User, error) {
	hash := sha256.Sum256([]byte(token))
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.resolves++
	if fake.hash == nil || *fake.hash != hash {
		return app.User{}, auth.ErrNotAuthenticated
	}
	return fake.user, nil
}
func (fake *fakeShortcutAuth) TouchShortcutToken(_ context.Context, token string) error {
	hash := sha256.Sum256([]byte(token))
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.hash != nil && *fake.hash == hash {
		used := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)
		fake.lastUsed = &used
	}
	return nil
}

type fakeShortcutBackend struct {
	fakeBackend
	throttled bool
	err       error
	calls     int
	userID    string
	filename  string
	body      string
}

func (fake *fakeShortcutBackend) AllowShortcutImport(string) bool { return !fake.throttled }
func (fake *fakeShortcutBackend) ShortcutImport(_ context.Context, userID, filename string, body io.Reader) (app.ShortcutImport, error) {
	content, err := io.ReadAll(body)
	if err != nil {
		return app.ShortcutImport{}, err
	}
	fake.calls++
	fake.userID, fake.filename, fake.body = userID, filename, string(content)
	if fake.err != nil {
		return app.ShortcutImport{}, fake.err
	}
	return app.ShortcutImport{
		DraftID: "d1", DraftPath: "/prepare/d1", Title: "Clair de lune", Composer: "Debussy, Claude",
		Matched: true, Filename: filename,
	}, nil
}

func shortcutRouter(backend Backend, authenticator Authenticator, mode string, maxUploadBytes int64) http.Handler {
	return NewRouter(backend, authenticator, config.Config{
		AppEnv: "test", AuthMode: mode, DevUserEmail: "learner@noted.local",
		AllowedEmails:  []string{"learner@noted.local"},
		MaxUploadBytes: maxUploadBytes, AllowedOrigin: testAllowedOrigin,
	})
}

// shortcutUpload builds the Shortcut's multipart request: one "file" part.
func shortcutUpload(token, filename, contentType, content string) *http.Request {
	body := &bytes.Buffer{}
	form := multipart.NewWriter(body)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, filename))
	header.Set("Content-Type", contentType)
	part, _ := form.CreatePart(header)
	_, _ = io.WriteString(part, content)
	_ = form.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/shortcut/import", body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request
}

func serve(router http.Handler, request *http.Request) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func createToken(t *testing.T, router http.Handler) string {
	t.Helper()
	response := serve(router, httptest.NewRequest(http.MethodPost, "/api/account/shortcut-token", nil))
	var created struct {
		Token     string    `json:"token"`
		CreatedAt time.Time `json:"createdAt"`
	}
	// The Shortcut is a static template now; the response carries no install link.
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &created) != nil ||
		len(created.Token) != 43 || created.CreatedAt.IsZero() || strings.Contains(response.Body.String(), "installUrl") ||
		response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("create token: %d %v %s", response.Code, response.Header(), response.Body.String())
	}
	return created.Token
}

func TestShortcutTokenLifecycle(t *testing.T) {
	tokens, backend := newFakeShortcutAuth(), &fakeShortcutBackend{}
	router := shortcutRouter(backend, tokens, "development", 1024)
	status := func() map[string]any {
		t.Helper()
		response := serve(router, httptest.NewRequest(http.MethodGet, "/api/account/shortcut-token", nil))
		var body map[string]any
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &body) != nil ||
			response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("token status: %d %s", response.Code, response.Body.String())
		}
		if _, leaked := body["token"]; leaked {
			t.Fatalf("status returned a token: %s", response.Body.String())
		}
		return body
	}
	upload := func(token string) int {
		return serve(router, shortcutUpload(token, "score.pdf", "application/pdf", "%PDF-1.7")).Code
	}

	if got := status(); got["active"] != false || got["createdAt"] != nil || got["lastUsedAt"] != nil {
		t.Fatalf("no token yet: %v", got)
	}
	first := createToken(t, router)
	if got := status(); got["active"] != true || got["createdAt"] == nil || got["lastUsedAt"] != nil {
		t.Fatalf("active token: %v", got)
	}
	if code := upload(first); code != http.StatusCreated {
		t.Fatalf("upload with the new token: %d", code)
	}
	if got := status(); got["lastUsedAt"] == nil {
		t.Fatalf("last use was not recorded: %v", got)
	}

	firstHash := *tokens.hash
	second := createToken(t, router)
	if second == first || *tokens.hash == firstHash {
		t.Fatal("replacing the token kept the old one")
	}
	if code := upload(first); code != http.StatusUnauthorized {
		t.Fatalf("replaced token still works: %d", code)
	}
	if code := upload(second); code != http.StatusCreated {
		t.Fatalf("replacement token: %d", code)
	}

	if response := serve(router, httptest.NewRequest(http.MethodDelete, "/api/account/shortcut-token", nil)); response.Code != http.StatusNoContent {
		t.Fatalf("turn off: %d %s", response.Code, response.Body.String())
	}
	if code := upload(second); code != http.StatusUnauthorized {
		t.Fatalf("turned-off token still works: %d", code)
	}
	if got := status(); got["active"] != false {
		t.Fatalf("after turning off: %v", got)
	}
	if backend.calls != 2 {
		t.Fatalf("backend imports = %d, want 2", backend.calls)
	}
}

func TestShortcutBearerMiddlewareRejectsAnythingButALiveToken(t *testing.T) {
	tokens, backend := newFakeShortcutAuth(), &fakeShortcutBackend{}
	router := shortcutRouter(backend, tokens, "development", 1024)
	live := createToken(t, router)
	revoked := createToken(t, router)
	live = createToken(t, router)
	tokens.ensureDevelopmentUserCalls = 0

	unknown := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	for name, header := range map[string]string{
		"missing":       "",
		"basic scheme":  "Basic " + live,
		"no token":      "Bearer",
		"empty token":   "Bearer ",
		"short":         "Bearer abc",
		"padded":        "Bearer " + live + "=",
		"bad character": "Bearer " + live[:42] + "+",
		"two spaces":    "Bearer  " + live[:42],
		"unknown":       "Bearer " + unknown,
		"revoked":       "Bearer " + revoked,
	} {
		request := shortcutUpload("", "score.pdf", "application/pdf", "%PDF-1.7")
		if header != "" {
			request.Header.Set("Authorization", header)
		}
		response := serve(router, request)
		if response.Code != http.StatusUnauthorized ||
			response.Body.String() != `{"error":"This shortcut was turned off. Set it up again in Noted."}`+"\n" ||
			!strings.HasPrefix(response.Header().Get("WWW-Authenticate"), "Bearer") {
			t.Errorf("%s: %d %q", name, response.Code, response.Body.String())
		}
	}
	if backend.calls != 0 || tokens.ensureDevelopmentUserCalls != 0 {
		t.Fatalf("a rejected request reached the backend (%d) or development sign-in (%d)",
			backend.calls, tokens.ensureDevelopmentUserCalls)
	}
	// Only the two well-formed tokens were looked up.
	if tokens.resolves != 2 {
		t.Fatalf("malformed headers reached the token store: %d lookups", tokens.resolves)
	}

	request := shortcutUpload(live, `..\..\IMSLP01240-Debussy.pdf`, "application/pdf", "%PDF-1.7")
	request.Header.Set("Authorization", "bearer "+live)
	if response := serve(router, request); response.Code != http.StatusCreated || backend.userID != testUserID {
		t.Fatalf("live token: %d user=%q %s", response.Code, backend.userID, response.Body.String())
	}
	if tokens.lastUsed == nil {
		t.Fatal("last use was not recorded")
	}
}

func TestShortcutTokenOwnerMustStillBeAllowed(t *testing.T) {
	for name, test := range map[string]struct {
		mode, email string
		allowed     bool
	}{
		"google, allow-listed":         {"google", "Learner@Noted.local", true},
		"google, removed from list":    {"google", "former@noted.local", false},
		"development, seeded learner":  {"development", "learner@noted.local", true},
		"development, another account": {"development", "someone@noted.local", false},
	} {
		t.Run(name, func(t *testing.T) {
			tokens, backend := newFakeShortcutAuth(), &fakeShortcutBackend{}
			token := createToken(t, shortcutRouter(backend, tokens, "development", 1024))
			tokens.user.Email = test.email
			response := serve(shortcutRouter(backend, tokens, test.mode, 1024),
				shortcutUpload(token, "score.pdf", "application/pdf", "%PDF-1.7"))
			if (response.Code == http.StatusCreated) != test.allowed {
				t.Fatalf("status %d: %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestShortcutTokenOpensOnlyTheImportRoute(t *testing.T) {
	tokens, backend := newFakeShortcutAuth(), &fakeShortcutBackend{}
	token := createToken(t, shortcutRouter(backend, tokens, "development", 1024))
	google := shortcutRouter(backend, tokens, "google", 1024)
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/imports/"},
		{http.MethodPost, "/api/imports/"},
		{http.MethodGet, "/api/pieces/"},
		{http.MethodGet, "/api/imslp/works?q=Prelude"},
		{http.MethodGet, "/api/account/shortcut-token"},
		{http.MethodPost, "/api/account/shortcut-token"},
		{http.MethodDelete, "/api/account/shortcut-token"},
	} {
		request := httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
		request.Header.Set("Authorization", "Bearer "+token)
		if response := serve(google, request); response.Code != http.StatusUnauthorized {
			t.Errorf("bearer token opened %s %s: %d", route.method, route.path, response.Code)
		}
	}
	if tokens.hash == nil {
		t.Fatal("a bearer request changed the token")
	}

	// The import route takes no session cookie, and development mode signs nobody in.
	withCookie := shortcutUpload("", "score.pdf", "application/pdf", "%PDF-1.7")
	withCookie.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: "session"})
	if response := serve(google, withCookie); response.Code != http.StatusUnauthorized {
		t.Fatalf("session cookie opened the import route: %d", response.Code)
	}
	tokens.ensureDevelopmentUserCalls = 0
	development := shortcutRouter(backend, tokens, "development", 1024)
	if response := serve(development, shortcutUpload("", "score.pdf", "application/pdf", "%PDF-1.7")); response.Code != http.StatusUnauthorized {
		t.Fatalf("development mode imported without a token: %d", response.Code)
	}
	if backend.calls != 0 || tokens.ensureDevelopmentUserCalls != 0 {
		t.Fatalf("rejected requests reached the backend (%d) or sign-in (%d)", backend.calls, tokens.ensureDevelopmentUserCalls)
	}
}

func TestShortcutImportChecksTheFileAndMapsErrors(t *testing.T) {
	tokens := newFakeShortcutAuth()
	token := createToken(t, shortcutRouter(&fakeShortcutBackend{}, tokens, "development", 1024))
	send := func(backend *fakeShortcutBackend, maxBytes int64, request *http.Request) *httptest.ResponseRecorder {
		return serve(shortcutRouter(backend, tokens, "development", maxBytes), request)
	}

	backend := &fakeShortcutBackend{}
	response := send(backend, 1024, shortcutUpload(token, `..\Downloads\IMSLP01240-Debussy.pdf`, "application/octet-stream", "%PDF-1.7 bytes"))
	var result map[string]any
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &result) != nil {
		t.Fatalf("import: %d %s", response.Code, response.Body.String())
	}
	for key, want := range map[string]any{
		"draftId": "d1", "draftPath": "/prepare/d1", "title": "Clair de lune",
		"composer": "Debussy, Claude", "matched": true, "filename": "IMSLP01240-Debussy.pdf",
	} {
		if result[key] != want {
			t.Errorf("%s = %v, want %v", key, result[key], want)
		}
	}
	if backend.filename != "IMSLP01240-Debussy.pdf" || backend.body != "%PDF-1.7 bytes" || backend.userID != testUserID {
		t.Fatalf("backend received %q %q for %q", backend.filename, backend.body, backend.userID)
	}

	// A PDF type is enough without a .pdf name, as on the drop target.
	backend = &fakeShortcutBackend{}
	if response := send(backend, 1024, shortcutUpload(token, "Shared score", "application/pdf", "%PDF-1.7")); response.Code != http.StatusCreated {
		t.Fatalf("PDF type without .pdf name: %d %s", response.Code, response.Body.String())
	}

	for name, test := range map[string]struct {
		request  *http.Request
		backend  *fakeShortcutBackend
		maxBytes int64
		status   int
		message  string
		reached  bool
	}{
		"image":            {shortcutUpload(token, "photo.jpg", "image/jpeg", "\xff\xd8"), &fakeShortcutBackend{}, 1024, 415, "Only PDF files can be sent.", false},
		"PDF name, image":  {shortcutUpload(token, "photo.pdf", "application/pdf", "\xff\xd8"), &fakeShortcutBackend{err: app.ErrNotPDF}, 1024, 415, "Only PDF files can be sent.", true},
		"oversize":         {shortcutUpload(token, "big.pdf", "application/pdf", "%PDF-"+strings.Repeat("x", 64)), &fakeShortcutBackend{}, 16, 413, "File is larger than Noted allows.", false},
		"over the request": {shortcutUpload(token, "big.pdf", "application/pdf", "%PDF-"+strings.Repeat("x", 2<<20)), &fakeShortcutBackend{}, 16, 413, "File is larger than Noted allows.", false},
		"draft limit":      {shortcutUpload(token, "a.pdf", "application/pdf", "%PDF-"), &fakeShortcutBackend{err: fmt.Errorf("create: %w", app.ErrDraftLimit)}, 1024, 429, "You have 20 open drafts. Finish or delete one in Noted, then send again.", true},
		"size from app":    {shortcutUpload(token, "a.pdf", "application/pdf", "%PDF-"), &fakeShortcutBackend{err: app.ErrImportLimit}, 1024, 413, "File is larger than Noted allows.", true},
		"asset store":      {shortcutUpload(token, "a.pdf", "application/pdf", "%PDF-"), &fakeShortcutBackend{err: fmt.Errorf("%w: disk full", app.ErrAssetStore)}, 1024, 503, "Noted couldn't store the file. Try again later.", true},
		"unreadable PDF":   {shortcutUpload(token, "a.pdf", "application/pdf", "%PDF-"), &fakeShortcutBackend{err: errors.New("PDF must be readable and unencrypted: bad xref")}, 1024, 400, "PDF must be readable and unencrypted: bad xref", true},
		"too fast":         {shortcutUpload(token, "a.pdf", "application/pdf", "%PDF-"), &fakeShortcutBackend{throttled: true}, 1024, 429, "Too many files sent in a minute. Wait a moment and send again.", false},
	} {
		t.Run(name, func(t *testing.T) {
			response := send(test.backend, test.maxBytes, test.request)
			var body struct{ Error string }
			_ = json.Unmarshal(response.Body.Bytes(), &body)
			if response.Code != test.status || body.Error != test.message || response.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("%d %s", response.Code, response.Body.String())
			}
			if reached := test.backend.calls > 0; reached != test.reached {
				t.Fatalf("backend reached = %v", reached)
			}
		})
	}

	noFile := httptest.NewRequest(http.MethodPost, "/api/shortcut/import", strings.NewReader("file=%PDF-"))
	noFile.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	noFile.Header.Set("Authorization", "Bearer "+token)
	if response := send(&fakeShortcutBackend{}, 1024, noFile); response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), "form field named file") {
		t.Fatalf("no file part: %d %s", response.Code, response.Body.String())
	}
}

func TestShortcutImportLogsTheUseButNeverTheFileOrToken(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	tokens, backend := newFakeShortcutAuth(), &fakeShortcutBackend{}
	router := shortcutRouter(backend, tokens, "development", 1024)
	token := createToken(t, router)
	response := serve(router, shortcutUpload(token, "IMSLP01240-Secret_title.pdf", "application/pdf", "%PDF-1.7"))
	if response.Code != http.StatusCreated {
		t.Fatalf("import: %d", response.Code)
	}
	line := logs.String()
	if strings.Count(line, "shortcut import accepted") != 1 || !strings.Contains(line, testUserID) ||
		!strings.Contains(line, "matched=true") {
		t.Fatalf("missing accepted-import log: %q", line)
	}
	if strings.Contains(line, "Secret_title") || strings.Contains(line, "IMSLP01240") || strings.Contains(line, token) {
		t.Fatalf("log names the file or token: %q", line)
	}
}
