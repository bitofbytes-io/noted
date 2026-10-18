package httpapi

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/bitofbytes-io/noted/internal/metrics"
)

// scrape reads the internal metrics listener's handler, as Prometheus would.
func scrape(t *testing.T, m *metrics.Metrics) string {
	t.Helper()
	response := serve(m.Handler(), httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("scrape: %d %s", response.Code, response.Body.String())
	}
	return response.Body.String()
}

// failures lists the sign-in failure series that are not zero.
func failures(t *testing.T, m *metrics.Metrics) []string {
	t.Helper()
	var lines []string
	for _, line := range strings.Split(scrape(t, m), "\n") {
		if (strings.HasPrefix(line, "noted_oauth_failures_total{") ||
			strings.HasPrefix(line, "noted_login_failures_total{")) && !strings.HasSuffix(line, " 0") {
			lines = append(lines, line)
		}
	}
	return lines
}

func TestMetricsLabelRoutePatternsAndCountDomainEvents(t *testing.T) {
	m := metrics.New()
	tokens, backend := newFakeShortcutAuth(), &fakeShortcutBackend{}
	router := NewRouter(backend, tokens, config.Config{
		AppEnv: "test", AuthMode: "development", DevUserEmail: "learner@noted.local",
		MaxUploadBytes: 1024, AllowedOrigin: testAllowedOrigin,
	}, m)
	const otherPieceID = "0b3b7c55-8e0e-4d3e-9c0e-3f1d2c4b5a69"
	for _, path := range []string{
		"/api/pieces/" + testPieceID + "/",
		"/api/pieces/" + otherPieceID + "/",
		"/api/pieces/" + testPieceID + "/reader-state",
		"/api/health",
		"/api/ready",
		"/api/no-such-route",
		"/api/pieces/" + testPieceID + "/no-such-route",
	} {
		serve(router, httptest.NewRequest(http.MethodGet, path, nil))
	}
	// The public router never serves metrics.
	if response := serve(router, httptest.NewRequest(http.MethodGet, "/metrics", nil)); response.Code != http.StatusNotFound {
		t.Fatalf("public /metrics = %d, want 404", response.Code)
	}
	if code := serve(router, shortcutUpload(strings.Repeat("x", 43), "score.pdf", "application/pdf", "%PDF-1.7")).Code; code != http.StatusUnauthorized {
		t.Fatalf("bad shortcut token = %d, want 401", code)
	}
	token := createToken(t, router)
	if code := serve(router, shortcutUpload(token, "score.pdf", "application/pdf", "%PDF-1.7")).Code; code != http.StatusCreated {
		t.Fatalf("shortcut upload = %d, want 201", code)
	}
	body := &bytes.Buffer{}
	form := multipart.NewWriter(body)
	_ = form.WriteField("revision", "1")
	file, _ := form.CreateFormFile("file", "score.pdf")
	_, _ = io.WriteString(file, "%PDF-1.7")
	_ = form.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/imports/"+testPieceID+"/sources", body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	// fakeShortcutBackend has no import backend, so the upload fails with 503.
	if code := serve(router, request).Code; code != http.StatusServiceUnavailable {
		t.Fatalf("source upload = %d, want 503", code)
	}

	output := scrape(t, m)
	for _, want := range []string{
		`http_requests_total{method="GET",route="/api/pieces/{pieceID}",status="200"} 2`,
		`http_requests_total{method="GET",route="/api/pieces/{pieceID}/reader-state",status="200"} 1`,
		`http_requests_total{method="GET",route="unmatched",status="404"} 2`,
		`http_requests_total{method="POST",route="/api/shortcut/import",status="201"} 1`,
		`http_requests_total{method="POST",route="/api/imports/{draftID}/sources",status="503"} 1`,
		`http_request_duration_seconds_count{method="GET",route="/api/pieces/{pieceID}",status="200"} 2`,
		`noted_uploads_total{kind="shortcut",result="success"} 1`,
		`noted_uploads_total{kind="source",result="error"} 1`,
		`noted_uploads_total{kind="finalize",result="success"} 0`,
		`noted_login_failures_total{reason="shortcut_token"} 1`,
		`noted_jobs_total{job="import_cleanup",result="success"} 0`,
		"go_goroutines ",
	} {
		if !strings.Contains(output, want) {
			t.Errorf("metrics missing %s", want)
		}
	}
	// A rejected token is a login failure, not an upload.
	if strings.Contains(output, `noted_uploads_total{kind="shortcut",result="rejected"} 1`) {
		t.Error("rejected shortcut token counted as an upload")
	}
	for _, leaked := range []string{testPieceID, otherPieceID, "no-such-route", "/api/health", "/api/ready", `route="/metrics"`} {
		if strings.Contains(output, leaked) {
			t.Errorf("metrics contain %q", leaked)
		}
	}
}

type panickingShortcutBackend struct{ fakeShortcutBackend }

func (*panickingShortcutBackend) ShortcutImport(context.Context, string, string, io.Reader) (app.ShortcutImport, error) {
	panic("storage exploded")
}

func TestMetricsCountRecoveredUploadPanicAsError(t *testing.T) {
	m := metrics.New()
	tokens := newFakeShortcutAuth()
	router := NewRouter(&panickingShortcutBackend{}, tokens, config.Config{
		AppEnv: "test", AuthMode: "development", DevUserEmail: "learner@noted.local",
		MaxUploadBytes: 1024, AllowedOrigin: testAllowedOrigin,
	}, m)
	token := createToken(t, router)
	if code := serve(router, shortcutUpload(token, "score.pdf", "application/pdf", "%PDF-1.7")).Code; code != http.StatusInternalServerError {
		t.Fatalf("panicking shortcut upload = %d, want 500", code)
	}
	output := scrape(t, m)
	for _, want := range []string{
		`noted_uploads_total{kind="shortcut",result="error"} 1`,
		`http_requests_total{method="POST",route="/api/shortcut/import",status="500"} 1`,
	} {
		if !strings.Contains(output, want) {
			t.Errorf("metrics missing %s", want)
		}
	}
}

func TestGoogleCallbackSuccessRecordsNoFailure(t *testing.T) {
	m := metrics.New()
	handler := callbackHandler(&fakeAuthenticator{returnPath: "/"}, newFakeGoogle(t))
	handler.metrics = m
	if response := callback(handler, "state=s&code=c", "s"); response.Code != http.StatusFound {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	if got := failures(t, m); len(got) != 0 {
		t.Fatalf("failures recorded: %v", got)
	}
}
