package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
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

// fakeGoogle stands in for Google's token and userinfo endpoints and records
// what the callback sent them.
type fakeGoogle struct {
	*httptest.Server
	tokenStatus int // 0 answers 200
	userStatus  int

	mu            sync.Mutex
	tokenForm     url.Values
	authorization string
}

func newFakeGoogle(t *testing.T) *fakeGoogle {
	google := &fakeGoogle{}
	google.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		google.mu.Lock()
		defer google.mu.Unlock()
		switch r.URL.Path {
		case "/token":
			_ = r.ParseForm()
			google.tokenForm = r.PostForm
			if google.tokenStatus != 0 {
				w.WriteHeader(google.tokenStatus)
				return
			}
			_, _ = io.WriteString(w, `{"access_token":"google-access-token"}`)
		case "/userinfo":
			google.authorization = r.Header.Get("Authorization")
			if google.userStatus != 0 {
				w.WriteHeader(google.userStatus)
				return
			}
			_, _ = io.WriteString(w, `{"sub":"google-subject","email":"learner@noted.local","email_verified":true,"name":"Learner","picture":"https://example.test/avatar.png"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(google.Close)
	return google
}

func (google *fakeGoogle) reached() bool {
	google.mu.Lock()
	defer google.mu.Unlock()
	return google.tokenForm != nil
}

func callbackHandler(authenticator *fakeAuthenticator, google *fakeGoogle) *Handler {
	return &Handler{
		auth: authenticator,
		config: config.Config{
			AppEnv: "test", AuthMode: "google", FrontendURL: "https://noted.example.test/",
			GoogleClientID: "client-id", GoogleSecret: "client-secret",
			GoogleRedirect: "https://noted.example.test/api/auth/google/callback",
		},
		googleTokenURL: google.URL + "/token", googleUserInfoURL: google.URL + "/userinfo",
	}
}

// callback is Google's redirect back to Noted, with the state cookie that the
// login start set when stateCookie is not empty.
func callback(handler *Handler, query, stateCookie string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "/api/auth/google/callback?"+query, nil)
	if stateCookie != "" {
		request.AddCookie(&http.Cookie{Name: auth.StateCookieName, Value: stateCookie})
	}
	response := httptest.NewRecorder()
	handler.googleCallback(response, request)
	return response
}

func responseCookie(response *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	return nil
}

func TestGoogleCallbackSignsInAndReturnsToTheRequestedPage(t *testing.T) {
	google := newFakeGoogle(t)
	authenticator := &fakeAuthenticator{returnPath: "/pieces/" + testPieceID + "?mode=scroll"}
	response := callback(callbackHandler(authenticator, google), "state=state-1&code=code-1", "state-1")

	if response.Code != http.StatusFound ||
		response.Header().Get("Location") != "https://noted.example.test/pieces/"+testPieceID+"?mode=scroll" {
		t.Fatalf("%d to %q: %s", response.Code, response.Header().Get("Location"), response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("headers: %v", response.Header())
	}
	if session := responseCookie(response, auth.SessionCookieName); session == nil || session.Value != "token" {
		t.Fatalf("session cookie: %+v", session)
	}
	if state := responseCookie(response, auth.StateCookieName); state == nil || state.MaxAge >= 0 {
		t.Fatalf("state cookie was not cleared: %+v", state)
	}
	if authenticator.consumedState != "state-1" || authenticator.sessionUserID != testUserID {
		t.Fatalf("consumed %q, session for %q", authenticator.consumedState, authenticator.sessionUserID)
	}
	want := auth.GoogleIdentity{
		Subject: "google-subject", Email: "learner@noted.local", Verified: true,
		DisplayName: "Learner", AvatarURL: "https://example.test/avatar.png",
	}
	if authenticator.identity == nil || *authenticator.identity != want {
		t.Fatalf("identity: %+v", authenticator.identity)
	}
	for key, value := range map[string]string{
		"code": "code-1", "client_id": "client-id", "client_secret": "client-secret",
		"grant_type": "authorization_code", "redirect_uri": "https://noted.example.test/api/auth/google/callback",
	} {
		if got := google.tokenForm.Get(key); got != value {
			t.Errorf("token request %s = %q, want %q", key, got, value)
		}
	}
	if google.authorization != "Bearer google-access-token" {
		t.Fatalf("userinfo Authorization = %q", google.authorization)
	}
}

func TestGoogleCallbackFailuresNeverStartASession(t *testing.T) {
	for name, test := range map[string]struct {
		mode          string
		query, cookie string
		authenticator fakeAuthenticator
		tokenStatus   int
		userStatus    int
		status        int
		message       string
		reachesGoogle bool
	}{
		"google sign-in off":   {mode: "development", query: "state=s&code=c", cookie: "s", status: 404, message: "google sign-in is not configured"},
		"user cancelled":       {query: "error=access_denied&state=s", cookie: "s", status: 401, message: "Google sign-in was not completed"},
		"no state cookie":      {query: "state=s&code=c", status: 401, message: "the sign-in request expired or was invalid"},
		"no state":             {query: "code=c", cookie: "s", status: 401, message: "the sign-in request expired or was invalid"},
		"state mismatch":       {query: "state=other&code=c", cookie: "s", status: 401, message: "the sign-in request expired or was invalid"},
		"state already used":   {query: "state=s&code=c", cookie: "s", authenticator: fakeAuthenticator{consumeErr: auth.ErrInvalidState}, status: 401, message: "the sign-in request expired or was already used"},
		"state lookup failed":  {query: "state=s&code=c", cookie: "s", authenticator: fakeAuthenticator{consumeErr: errors.New("connection reset")}, status: 500, message: "internal server error"},
		"no code":              {query: "state=s", cookie: "s", status: 401, message: "Google did not return an authorization code"},
		"token exchange fails": {query: "state=s&code=c", cookie: "s", tokenStatus: 400, status: 502, message: "Google sign-in could not be completed", reachesGoogle: true},
		"userinfo fails":       {query: "state=s&code=c", cookie: "s", userStatus: 500, status: 502, message: "Google sign-in could not be completed", reachesGoogle: true},
		"email not allowed":    {query: "state=s&code=c", cookie: "s", authenticator: fakeAuthenticator{authErr: auth.ErrEmailNotAllowed}, status: 403, message: "this Google account is not allowed to use Noted", reachesGoogle: true},
		"identity conflict":    {query: "state=s&code=c", cookie: "s", authenticator: fakeAuthenticator{authErr: auth.ErrIdentityConflict}, status: 409, message: "this email is linked to a different Google account", reachesGoogle: true},
		"user store fails":     {query: "state=s&code=c", cookie: "s", authenticator: fakeAuthenticator{authErr: errors.New("connection reset")}, status: 500, message: "internal server error", reachesGoogle: true},
		"session store fails":  {query: "state=s&code=c", cookie: "s", authenticator: fakeAuthenticator{sessionErr: errors.New("connection reset")}, status: 500, message: "internal server error", reachesGoogle: true},
	} {
		t.Run(name, func(t *testing.T) {
			google := newFakeGoogle(t)
			google.tokenStatus, google.userStatus = test.tokenStatus, test.userStatus
			authenticator := test.authenticator
			handler := callbackHandler(&authenticator, google)
			if test.mode != "" {
				handler.config.AuthMode = test.mode
			}
			response := callback(handler, test.query, test.cookie)

			var body struct{ Error string }
			_ = json.Unmarshal(response.Body.Bytes(), &body)
			if response.Code != test.status || body.Error != test.message {
				t.Fatalf("%d %s", response.Code, response.Body.String())
			}
			if session := responseCookie(response, auth.SessionCookieName); session != nil {
				t.Fatalf("session cookie set: %+v", session)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
			}
			// Once Google mode is on, every outcome spends the state cookie.
			state := responseCookie(response, auth.StateCookieName)
			if cleared := state != nil && state.MaxAge < 0; cleared != (test.mode == "") {
				t.Fatalf("state cookie: %+v", state)
			}
			if google.reached() != test.reachesGoogle {
				t.Fatalf("token endpoint reached = %v", google.reached())
			}
		})
	}
}
