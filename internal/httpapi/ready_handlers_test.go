package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/jackc/pgx/v5/pgxpool"
)

// readinessFake records the deadline each check saw and fails with the given errors.
type readinessFake struct {
	fakeBackend
	dbErr, assetsErr   error
	dbLeft, assetsLeft time.Duration
}

func (fake *readinessFake) PingDatabase(ctx context.Context) error {
	fake.dbLeft = remaining(ctx)
	return fake.dbErr
}

func (fake *readinessFake) CheckAssetStore(ctx context.Context) error {
	fake.assetsLeft = remaining(ctx)
	return fake.assetsErr
}

func remaining(ctx context.Context) time.Duration {
	deadline, ok := ctx.Deadline()
	if !ok {
		return 0
	}
	return time.Until(deadline)
}

// googleRouter has no development user, so a route behind authenticatedUser
// answers 401 without a session cookie.
func googleRouter(backend Backend) http.Handler {
	return NewRouter(backend, &fakeAuthenticator{}, config.Config{
		AppEnv: "test", AuthMode: "google", MaxUploadBytes: 1024, AllowedOrigin: testAllowedOrigin,
	})
}

func get(router http.Handler, path string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
	return response
}

func TestReadyReportsOKWithoutASessionAndBoundsChecks(t *testing.T) {
	fake := &readinessFake{}
	router := googleRouter(fake)
	if response := get(router, "/api/pieces/"); response.Code != http.StatusUnauthorized {
		t.Fatalf("control route without a session: %d", response.Code)
	}
	response := get(router, "/api/ready")
	if response.Code != http.StatusOK ||
		strings.TrimSpace(response.Body.String()) != `{"assets":"ok","db":"ok","status":"ok"}` {
		t.Fatalf("ready: %d %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
	for name, left := range map[string]time.Duration{"db": fake.dbLeft, "assets": fake.assetsLeft} {
		if left <= 0 || left > readinessTimeout {
			t.Fatalf("%s check deadline = %s, want within %s", name, left, readinessTimeout)
		}
	}
}

func TestReadyReportsFailingDependencyWithoutErrorText(t *testing.T) {
	secret := errors.New("dial postgres://noted:hunter2@db.internal:5432/noted: connection refused")
	for name, test := range map[string]struct {
		fake *readinessFake
		body string
	}{
		"db":     {&readinessFake{dbErr: secret}, `{"assets":"ok","db":"error","status":"degraded"}`},
		"assets": {&readinessFake{assetsErr: errors.New("stat /mnt/noted-assets/objects: stale NFS file handle")}, `{"assets":"error","db":"ok","status":"degraded"}`},
		"both":   {&readinessFake{dbErr: secret, assetsErr: context.DeadlineExceeded}, `{"assets":"error","db":"error","status":"degraded"}`},
	} {
		t.Run(name, func(t *testing.T) {
			response := get(googleRouter(test.fake), "/api/ready")
			if response.Code != http.StatusServiceUnavailable || strings.TrimSpace(response.Body.String()) != test.body {
				t.Fatalf("ready: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestHealthStaysStaticWhenDependenciesFail(t *testing.T) {
	fake := &readinessFake{dbErr: errors.New("down"), assetsErr: errors.New("down")}
	response := get(googleRouter(fake), "/api/health")
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"status":"ok"}` {
		t.Fatalf("health: %d %s", response.Code, response.Body.String())
	}
}

func TestReadyIsDegradedWithoutReadinessChecks(t *testing.T) {
	response := get(googleRouter(&fakeBackend{}), "/api/ready")
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"status":"degraded"`) {
		t.Fatalf("ready: %d %s", response.Code, response.Body.String())
	}
}

// The real service against a closed database port: the pool connects lazily,
// so only the readiness ping notices.
func TestReadyReportsUnreachableDatabase(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), "postgres://noted:secret@127.0.0.1:1/noted?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store, err := assets.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	response := get(googleRouter(app.NewService(pool, store)), "/api/ready")
	if response.Code != http.StatusServiceUnavailable ||
		strings.TrimSpace(response.Body.String()) != `{"assets":"ok","db":"error","status":"degraded"}` {
		t.Fatalf("ready: %d %s", response.Code, response.Body.String())
	}
}
