package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/bitofbytes-io/noted/internal/metrics"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func exportHTTPIntegrationSetup(t *testing.T) (context.Context, *pgxpool.Pool, assets.Store, *auth.Service, app.User, app.User) {
	t.Helper()
	dsn := os.Getenv("NOTED_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store, err := assets.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	emailA, emailB := uuid.NewString()+"@example.test", uuid.NewString()+"@example.test"
	authentication := auth.NewService(pool, []string{emailA, emailB}, time.Hour)
	users := make([]app.User, 2)
	for i, email := range []string{emailA, emailB} {
		user, err := authentication.AuthenticateGoogle(ctx, auth.GoogleIdentity{Subject: uuid.NewString(), Email: email, DisplayName: "Export tester", Verified: true})
		if err != nil {
			t.Fatal(err)
		}
		users[i] = user
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM pieces WHERE user_id=ANY($1::uuid[])`, []string{users[0].ID, users[1].ID}); err != nil {
			t.Error(err)
		}
		if _, err := pool.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1::uuid[])`, []string{users[0].ID, users[1].ID}); err != nil {
			t.Error(err)
		}
	})
	return ctx, pool, store, authentication, users[0], users[1]
}
func exportHTTPToken(t *testing.T, ctx context.Context, a *auth.Service, owner string) string {
	t.Helper()
	token, _, err := a.NewSession(ctx, owner, "export-test", "192.0.2.1")
	if err != nil {
		t.Fatal(err)
	}
	return token
}
func exportHTTPRequest(t *testing.T, server *httptest.Server, token, bearer string) (int, http.Header, []byte) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, server.URL+"/api/library/export", nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: token, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	}
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil {
		t.Fatal(readErr, closeErr)
	}
	return response.StatusCode, response.Header, body
}
func TestIntegrationLibraryExportBrowserAuthentication(t *testing.T) {
	ctx, pool, store, authentication, owner, other := exportHTTPIntegrationSetup(t)
	service := app.NewService(pool, store)
	own, err := service.CreatePiece(ctx, owner.ID, app.PieceInput{Title: "OWN EXPORT"})
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := service.CreatePiece(ctx, other.ID, app.PieceInput{Title: "FOREIGN PRIVATE"})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewRouter(service, authentication, config.Config{AuthMode: "google"}, metrics.New()))
	defer server.Close()
	shortcut, _, err := authentication.CreateShortcutToken(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, bearer := range []string{"", shortcut} {
		status, _, _ := exportHTTPRequest(t, server, "", bearer)
		if status != http.StatusUnauthorized {
			t.Fatal("unauthenticated export", status)
		}
	}
	token := exportHTTPToken(t, ctx, authentication, owner.ID)
	status, headers, data := exportHTTPRequest(t, server, token, "")
	if status != http.StatusOK || headers.Get("Content-Type") != "application/zip" {
		t.Fatal("valid session failed", status)
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.File) != 2 {
		t.Fatal("metadata-only archive entries", len(archive.File))
	}
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil {
			t.Fatal(readErr, closeErr)
		}
		if !bytes.Contains(body, []byte(own.ID)) || bytes.Contains(body, []byte(foreign.ID)) {
			t.Fatal("export crossed account boundary")
		}
	}
	status, headers, _ = exportHTTPRequest(t, server, token, "")
	if status != http.StatusTooManyRequests || headers.Get("Retry-After") == "" {
		t.Fatal("rate limit missing")
	}
	if _, err := pool.Exec(ctx, `UPDATE user_sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1`, owner.ID); err != nil {
		t.Fatal(err)
	}
	status, _, _ = exportHTTPRequest(t, server, token, "")
	if status != http.StatusUnauthorized {
		t.Fatal("expired session exported", status)
	}
	token = exportHTTPToken(t, ctx, authentication, owner.ID)
	disallowed := httptest.NewServer(NewRouter(service, auth.NewService(pool, []string{other.Email}, time.Hour), config.Config{AuthMode: "google"}, nil))
	defer disallowed.Close()
	status, _, _ = exportHTTPRequest(t, disallowed, token, "")
	if status != http.StatusUnauthorized {
		t.Fatal("removed allow-list user exported", status)
	}
}

type exportCancelStore struct {
	assets.Store
	started chan struct{}
	closed  atomic.Bool
}

func (s *exportCancelStore) Open(ctx context.Context, _ string) (assets.ReadSeekCloser, error) {
	return &exportCancelReader{ctx: ctx, store: s}, nil
}

type exportCancelReader struct {
	ctx   context.Context
	store *exportCancelStore
	read  bool
}

func (r *exportCancelReader) Read(p []byte) (int, error) {
	if !r.read {
		r.read = true
		clear(p)
		close(r.store.started)
		return len(p), nil
	}
	<-r.ctx.Done()
	return 0, r.ctx.Err()
}
func (*exportCancelReader) Seek(int64, int) (int64, error) {
	return 0, errors.New("export must not seek")
}
func (r *exportCancelReader) Close() error { r.store.closed.Store(true); return nil }
func TestIntegrationLibraryExportDisconnectReleasesReaderSnapshotAndSlot(t *testing.T) {
	ctx, pool, baseStore, authentication, owner, _ := exportHTTPIntegrationSetup(t)
	store := &exportCancelStore{Store: baseStore, started: make(chan struct{})}
	service := app.NewService(pool, store)
	piece, err := service.CreatePiece(ctx, owner.ID, app.PieceInput{Title: "Synthetic streamed score"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO piece_pdfs(piece_id,storage_key,original_filename,size_bytes,checksum_sha256,page_count) VALUES($1,$2,'test.pdf',1048576,$3,1)`, piece.ID, "fixture-export-only-key", strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	token := exportHTTPToken(t, ctx, authentication, owner.ID)
	done := make(chan struct{})
	var once sync.Once
	router := NewRouter(service, authentication, config.Config{AuthMode: "google"}, metrics.New())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer once.Do(func() { close(done) })
		router.ServeHTTP(w, r)
	}))
	defer server.Close()
	request, err := http.NewRequest(http.MethodGet, server.URL+"/api/library/export", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: token, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-store.started:
	case <-time.After(3 * time.Second):
		if err := response.Body.Close(); err != nil {
			t.Error(err)
		}
		t.Fatal("PDF reader never opened")
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled export stuck")
	}
	if !store.closed.Load() || pool.Stat().AcquiredConns() != 0 {
		t.Fatal("cancelled export leaked reader or transaction")
	}
	status, headers, _ := exportHTTPRequest(t, server, token, "")
	retry, err := strconv.Atoi(headers.Get("Retry-After"))
	if status != http.StatusTooManyRequests || err != nil || retry <= 1 {
		t.Fatal("active slot survived disconnect", status, retry, err)
	}
}
