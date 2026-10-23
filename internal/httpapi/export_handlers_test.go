package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/bitofbytes-io/noted/internal/metrics"
)

type exportFakeBackend struct {
	*fakeBackend
	run func(context.Context, string, io.Writer) error
}

func (f *exportFakeBackend) ExportLibrary(ctx context.Context, id string, w io.Writer) error {
	return f.run(ctx, id, w)
}

type exportDeadlineRecorder struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
	failWrite bool
}

func (w *exportDeadlineRecorder) SetWriteDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	return nil
}
func (w *exportDeadlineRecorder) Write(p []byte) (int, error) {
	if w.failWrite {
		return 0, errors.New("private writer failure")
	}
	return w.ResponseRecorder.Write(p)
}

type exportSessionAuth struct {
	fakeAuthenticator
	err error
}

func (a *exportSessionAuth) ResolveSession(context.Context, string) (app.User, time.Time, error) {
	if a.err != nil {
		return app.User{}, time.Time{}, a.err
	}
	return app.User{ID: testUserID}, time.Now().Add(90 * 24 * time.Hour), nil
}
func TestLibraryExportRequiresBrowserSession(t *testing.T) {
	for _, name := range []string{"anonymous", "expired", "disallowed", "shortcut"} {
		t.Run(name, func(t *testing.T) {
			backend := &exportFakeBackend{fakeBackend: &fakeBackend{}, run: func(context.Context, string, io.Writer) error { t.Error("unauthorized backend called"); return nil }}
			router := NewRouter(backend, &exportSessionAuth{err: auth.ErrNotAuthenticated}, config.Config{AuthMode: "google"}, metrics.New())
			request := httptest.NewRequest(http.MethodGet, "/api/library/export", nil)
			if name == "expired" || name == "disallowed" {
				request.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: "invalid", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
			}
			if name == "shortcut" {
				request.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 43))
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d", response.Code)
			}
		})
	}
}
func TestLibraryExportDeadlineHeadersAndErrorsThroughMetrics(t *testing.T) {
	for _, name := range []string{"success", "database", "limited", "write"} {
		t.Run(name, func(t *testing.T) {
			backend := &exportFakeBackend{fakeBackend: &fakeBackend{}, run: func(ctx context.Context, id string, w io.Writer) error {
				if id != testUserID {
					t.Error("wrong owner")
				}
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > exportTimeout || time.Until(deadline) < exportTimeout-time.Second {
					t.Error("export deadline missing")
				}
				switch name {
				case "database":
					return errors.New("private path SQL credential")
				case "limited":
					return &app.ExportLimitError{RetryAfter: 1500 * time.Millisecond}
				}
				archive := zip.NewWriter(w)
				entry, err := archive.Create("library.json")
				if err != nil {
					return err
				}
				if _, err = io.WriteString(entry, `{"pieces":[]}`); err != nil {
					return err
				}
				return archive.Close()
			}}
			router := NewRouter(backend, &fakeAuthenticator{}, config.Config{AuthMode: "development"}, metrics.New())
			w := &exportDeadlineRecorder{ResponseRecorder: httptest.NewRecorder(), failWrite: name == "write"}
			var recovered any
			func() {
				defer func() { recovered = recover() }()
				router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/library/export", nil))
			}()
			if len(w.deadlines) != 2 || !w.deadlines[1].IsZero() {
				t.Fatal("deadline not reset through metrics", w.deadlines)
			}
			if name == "write" {
				if recovered != http.ErrAbortHandler {
					t.Fatalf("write failure did not abort: %v", recovered)
				}
				return
			}
			if recovered != nil {
				t.Fatal(recovered)
			}
			if name == "success" {
				if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/zip" || w.Header().Get("Content-Disposition") != `attachment; filename="noted-library.zip"` || w.Header().Get("Cache-Control") != "private, no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Content-Length") != "" {
					t.Fatal("incorrect download headers", w.Header())
				}
				if _, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len())); err != nil {
					t.Fatal(err)
				}
			} else {
				expected := http.StatusInternalServerError
				if name == "limited" {
					expected = http.StatusTooManyRequests
					if w.Header().Get("Retry-After") != "2" {
						t.Fatal("missing retry delay")
					}
				}
				if w.Code != expected || w.Header().Get("Content-Type") != "application/json" || strings.Contains(w.Body.String(), "private") {
					t.Fatal("unsafe structured failure", w.Code, w.Body.String())
				}
			}
		})
	}
}
func TestLibraryExportRefusesUnsupportedDeadline(t *testing.T) {
	backend := &exportFakeBackend{fakeBackend: &fakeBackend{}, run: func(context.Context, string, io.Writer) error { t.Error("unbounded export started"); return nil }}
	w := httptest.NewRecorder()
	testRouter(backend, 1024).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/library/export", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatal(w.Code)
	}
}
func TestLibraryExportRealHTTPAbortAndCancellation(t *testing.T) {
	for _, cancelClient := range []bool{false, true} {
		t.Run(map[bool]string{false: "failure", true: "cancellation"}[cancelClient], func(t *testing.T) {
			done := make(chan struct{})
			backend := &exportFakeBackend{fakeBackend: &fakeBackend{}, run: func(ctx context.Context, _ string, w io.Writer) error {
				defer close(done)
				archive := zip.NewWriter(w)
				entry, err := archive.CreateHeader(&zip.FileHeader{Name: "scores/partial.pdf", Method: zip.Store})
				if err != nil {
					return err
				}
				if _, err = entry.Write(make([]byte, 64<<10)); err != nil {
					return err
				}
				if err = archive.Flush(); err != nil {
					return err
				}
				if cancelClient {
					<-ctx.Done()
					return ctx.Err()
				}
				return errors.New("private asset failure")
			}}
			server := httptest.NewServer(NewRouter(backend, &fakeAuthenticator{}, config.Config{AuthMode: "development"}, metrics.New()))
			defer server.Close()
			client := server.Client()
			client.Timeout = 5 * time.Second
			response, err := client.Get(server.URL + "/api/library/export")
			if err != nil {
				t.Fatal(err)
			}
			if cancelClient {
				prefix := make([]byte, 16)
				_, readErr := io.ReadFull(response.Body, prefix)
				closeErr := response.Body.Close()
				if readErr != nil || closeErr != nil {
					t.Fatal(readErr, closeErr)
				}
			} else {
				data, readErr := io.ReadAll(response.Body)
				closeErr := response.Body.Close()
				if closeErr != nil {
					t.Fatal(closeErr)
				}
				if readErr == nil {
					t.Fatal("partial response was not aborted")
				}
				if _, err := zip.NewReader(bytes.NewReader(data), int64(len(data))); err == nil {
					t.Fatal("partial ZIP finalized")
				}
				if bytes.Contains(data, []byte("private asset failure")) {
					t.Fatal("error leaked")
				}
			}
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("export did not release after disconnect")
			}
		})
	}
}
