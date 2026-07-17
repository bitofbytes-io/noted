package httptransport

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/bitofbytes-io/noted/internal/config"
)

func TestProductionSessionCookieSecurity(t *testing.T) {
	handler := Handler{Config: config.Config{AppEnv: "production"}}
	recorder := httptest.NewRecorder()
	handler.setSessionCookie(recorder, "opaque-token", time.Now().Add(time.Hour))

	response := recorder.Result()
	cookies := response.Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies = %d, want 1", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != auth.SessionCookieName || cookie.Value != "opaque-token" {
		t.Fatalf("unexpected session cookie: %+v", cookie)
	}
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" {
		t.Fatalf("session cookie is missing security attributes: %+v", cookie)
	}
}

func TestDevelopmentCookiesAreUsableOnLocalHTTP(t *testing.T) {
	handler := Handler{Config: config.Config{AppEnv: "development"}}
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

func TestRemoteIP(t *testing.T) {
	if got := remoteIP("192.0.2.10:4567"); got != "192.0.2.10" {
		t.Fatalf("remoteIP with port = %q", got)
	}
	if got := remoteIP("2001:db8::1"); got != "2001:db8::1" {
		t.Fatalf("remoteIP without port = %q", got)
	}
}

func TestSessionReportsConfiguredRecognitionCapability(t *testing.T) {
	for _, test := range []struct {
		name       string
		recognizer app.Recognizer
		want       bool
	}{
		{name: "disabled", want: false},
		{name: "remote worker enabled", recognizer: app.HTTPRecognizer{BaseURL: "http://worker:8788", Token: "token"}, want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler := Handler{
				Service: &app.Service{Recognizer: test.recognizer},
				Config:  config.Config{AuthMode: "google"},
			}
			recorder := httptest.NewRecorder()
			handler.session(recorder, httptest.NewRequest(http.MethodGet, "/api/session", nil))
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d", recorder.Code)
			}
			var response struct {
				Capabilities struct {
					Recognition bool `json:"recognition"`
				} `json:"capabilities"`
			}
			if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
				t.Fatal(err)
			}
			if response.Capabilities.Recognition != test.want {
				t.Fatalf("recognition capability = %v, want %v", response.Capabilities.Recognition, test.want)
			}
		})
	}
}
