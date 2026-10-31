package httpapi

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bitofbytes-io/noted/internal/config"
)

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
	if err := form.WriteField("revision", "1"); err != nil {
		t.Fatal(err)
	}
	file, err := form.CreateFormFile("file", "score.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(file, "%PDF-safe"); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Error(err)
	}
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
