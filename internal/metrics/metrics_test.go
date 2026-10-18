package metrics

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func scrape(t *testing.T, m *Metrics) string {
	t.Helper()
	response := httptest.NewRecorder()
	m.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("scrape: %d %s", response.Code, response.Body.String())
	}
	return response.Body.String()
}

func TestMiddlewareLabelsByRoutePattern(t *testing.T) {
	m := New()
	router := chi.NewRouter()
	router.Use(m.Middleware("/health"))
	router.Get("/health", func(http.ResponseWriter, *http.Request) {})
	router.Route("/items", func(router chi.Router) {
		router.Get("/{id}", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	})
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/items/1", nil),
		httptest.NewRequest(http.MethodGet, "/items/2?q=secret", nil),
		httptest.NewRequest(http.MethodGet, "/items/1/extra", nil),
		httptest.NewRequest(http.MethodGet, "/elsewhere", nil),
		httptest.NewRequest(http.MethodPost, "/items/1", nil),
		httptest.NewRequest("BREW", "/items/1", nil),
		httptest.NewRequest(http.MethodGet, "/health", nil),
		httptest.NewRequest(http.MethodGet, "/metrics", nil),
	} {
		router.ServeHTTP(httptest.NewRecorder(), request)
	}

	output := scrape(t, m)
	for _, want := range []string{
		`http_requests_total{method="GET",route="/items/{id}",status="418"} 2`,
		`http_requests_total{method="GET",route="unmatched",status="404"} 2`,
		`http_requests_total{method="POST",route="unmatched",status="405"} 1`,
		`http_requests_total{method="OTHER",route="unmatched",status="405"} 1`,
		`http_request_duration_seconds_bucket{method="GET",route="/items/{id}",status="418",le="+Inf"} 2`,
	} {
		if !strings.Contains(output, want) {
			t.Errorf("metrics missing %s\n%s", want, output)
		}
	}
	for _, leaked := range []string{"/items/1", "/items/2", "secret", "extra", "elsewhere", "/health", "BREW"} {
		if strings.Contains(output, leaked) {
			t.Errorf("metrics contain %q", leaked)
		}
	}
}

func TestCountUploadsByResponseStatus(t *testing.T) {
	m := New()
	for _, status := range []int{http.StatusCreated, http.StatusRequestEntityTooLarge, http.StatusServiceUnavailable, 0} {
		handler := m.CountUploads(UploadSource)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if status != 0 {
				w.WriteHeader(status)
			}
		}))
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/", nil))
	}
	output := scrape(t, m)
	for _, want := range []string{
		`noted_uploads_total{kind="source",result="success"} 2`,
		`noted_uploads_total{kind="source",result="rejected"} 1`,
		`noted_uploads_total{kind="source",result="error"} 1`,
	} {
		if !strings.Contains(output, want) {
			t.Errorf("metrics missing %s", want)
		}
	}
}

func TestDomainCountersAndRuntimeCollectors(t *testing.T) {
	m := New()
	m.OAuthFailure("google", OAuthExchange)
	m.LoginFailure(LoginNotAllowed)
	m.JobRun(JobImportCleanup, nil)
	m.JobRun(JobImportCleanup, errors.New("database is down"))
	m.JobRun(JobImportCleanup, errors.New("database is down"))
	output := scrape(t, m)
	for _, want := range []string{
		`noted_oauth_failures_total{provider="google",reason="exchange"} 1`,
		`noted_oauth_failures_total{provider="google",reason="invalid_state"} 0`,
		`noted_login_failures_total{reason="not_allowed"} 1`,
		`noted_jobs_total{job="import_cleanup",result="success"} 1`,
		`noted_jobs_total{job="import_cleanup",result="error"} 2`,
		"go_goroutines ",
		"go_gc_duration_seconds",
	} {
		if !strings.Contains(output, want) {
			t.Errorf("metrics missing %s", want)
		}
	}
}

func TestNilMetricsRecordNothing(t *testing.T) {
	var m *Metrics
	m.OAuthFailure("google", OAuthExchange)
	m.LoginFailure(LoginNotAllowed)
	m.JobRun(JobImportCleanup, nil)
	called := 0
	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called++ })
	m.Middleware()(next).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	m.CountUploads(UploadShortcut)(next).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/", nil))
	if called != 2 {
		t.Fatalf("next called %d times, want 2", called)
	}
}

func TestPoolCollectorExportsStat(t *testing.T) {
	// pgxpool connects lazily, so this pool never needs a server.
	pool, err := pgxpool.New(context.Background(), "postgres://unused@127.0.0.1:1/unused?pool_max_conns=7")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	m := New()
	if err := m.RegisterPool(pool); err != nil {
		t.Fatal(err)
	}
	output := scrape(t, m)
	for _, want := range []string{
		"pgxpool_max_conns 7", "pgxpool_acquired_conns 0", "pgxpool_idle_conns 0", "pgxpool_total_conns 0",
		"pgxpool_acquires_total 0", "pgxpool_empty_acquires_total 0", "pgxpool_empty_acquire_wait_seconds_total 0",
		"# TYPE pgxpool_acquires_total counter", "# TYPE pgxpool_acquired_conns gauge",
	} {
		if !strings.Contains(output, want) {
			t.Errorf("metrics missing %s", want)
		}
	}
}

func TestServeStartsAndStopsTheInternalListener(t *testing.T) {
	m := New()
	if server := m.Serve(Off); server != nil {
		t.Fatal("Serve(off) started a listener")
	}
	// Find a free port, then serve on it.
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := probe.Addr().String()
	_ = probe.Close()
	server := m.Serve(addr)
	if server == nil {
		t.Fatal("Serve returned nil for a free address")
	}
	// A second listener on the same address fails to bind and is not fatal.
	if second := m.Serve(addr); second != nil {
		_ = second.Close()
		t.Fatal("Serve on a bound address returned a server")
	}
	response, err := http.Get("http://" + addr + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "noted_uploads_total") {
		t.Fatalf("GET /metrics = %d", response.StatusCode)
	}
	if response, err := http.Get("http://" + addr + "/"); err != nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("GET / = %v %v, want 404", response, err)
	} else {
		_ = response.Body.Close()
	}
	if err := server.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := http.Get("http://" + addr + "/metrics"); err == nil {
		t.Fatal("listener still serving after shutdown")
	}
}
