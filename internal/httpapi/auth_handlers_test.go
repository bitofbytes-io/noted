package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/bitofbytes-io/noted/internal/config"
)

func TestProductionSessionCookieSecurity(t *testing.T) {
	handler := Handler{config: config.Config{AppEnv: "production"}}
	recorder := httptest.NewRecorder()
	expiresAt := time.Now().Add(90 * 24 * time.Hour)
	handler.setSessionCookie(recorder, "opaque-token", expiresAt)

	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies = %d, want 1", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != auth.SessionCookieName || cookie.Value != "opaque-token" {
		t.Fatalf("unexpected session cookie: %+v", cookie)
	}
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode ||
		cookie.Path != "/" {
		t.Fatalf("session cookie is missing security attributes: %+v", cookie)
	}
	if !cookie.Expires.Equal(expiresAt.Truncate(time.Second)) {
		t.Fatalf("cookie expiry = %v, want session expiry %v", cookie.Expires, expiresAt)
	}
	if cookie.MaxAge <= 0 {
		t.Fatalf("cookie MaxAge = %d, want a persistent session cookie", cookie.MaxAge)
	}
}

func TestDevelopmentStateCookieWorksOnHTTP(t *testing.T) {
	handler := Handler{config: config.Config{AppEnv: "development"}}
	recorder := httptest.NewRecorder()
	handler.setStateCookie(recorder, "state")
	cookie := recorder.Result().Cookies()[0]
	if cookie.Secure {
		t.Fatal("development OAuth state cookie unexpectedly requires HTTPS")
	}
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("development state cookie is missing security attributes: %+v", cookie)
	}
}

func TestGoogleModeRejectsMissingSession(t *testing.T) {
	router := NewRouter(&fakeBackend{}, &fakeAuthenticator{}, config.Config{
		AppEnv: "test", AuthMode: "google", MaxUploadBytes: 1024,
	})
	request := httptest.NewRequest(http.MethodGet, "/api/pieces/", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401: %s", response.Code, response.Body.String())
	}
}

func TestGoogleModeRejectsUnauthenticatedPDFDownload(t *testing.T) {
	router := NewRouter(&fakeBackend{}, &fakeAuthenticator{}, config.Config{
		AppEnv: "test", AuthMode: "google", MaxUploadBytes: 1024,
	})
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/pieces/"+testPieceID+"/pdf/download",
		nil,
	)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401: %s", response.Code, response.Body.String())
	}
}

func TestRemoteIP(t *testing.T) {
	if actual := remoteIP("192.0.2.10:4567"); actual != "192.0.2.10" {
		t.Fatalf("remoteIP with port = %q", actual)
	}
	if actual := remoteIP("2001:db8::1"); actual != "2001:db8::1" {
		t.Fatalf("remoteIP without port = %q", actual)
	}
}
