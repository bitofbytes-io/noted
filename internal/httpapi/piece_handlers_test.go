package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bitofbytes-io/noted/internal/app"
)

func TestContinuePieceForTheCurrentUser(t *testing.T) {
	fake := &fakeBackend{}
	router := testRouter(fake, 1024)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/pieces/continue", nil))
	if response.Code != http.StatusOK || fake.continueUserID != testUserID ||
		response.Body.String() != "{\"piece\":null}\n" {
		t.Fatalf("nothing to continue: %d %q user=%q", response.Code, response.Body.String(), fake.continueUserID)
	}

	fake.continued = &app.Piece{ID: testPieceID, Title: "Nocturne"}
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/pieces/continue", nil))
	if response.Code != http.StatusOK ||
		!strings.Contains(response.Body.String(), `"id":"`+testPieceID+`","title":"Nocturne"`) {
		t.Fatalf("continue: %d %s", response.Code, response.Body.String())
	}
}

func TestPreferencesReadAndWriteForTheCurrentUser(t *testing.T) {
	fake := &fakeBackend{}
	router := testRouter(fake, 1024)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/account/preferences", nil))
	if response.Code != http.StatusOK || fake.preferencesUserID != testUserID ||
		!strings.Contains(response.Body.String(), `"libraryFilter":"current"`) ||
		!strings.Contains(response.Body.String(), `"librarySort":"title"`) {
		t.Fatalf("get preferences: %d %s", response.Code, response.Body.String())
	}
	request := httptest.NewRequest(http.MethodPut, "/api/account/preferences", strings.NewReader(`{"libraryFilter":"favorites"}`))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.preferencesPatch.LibraryFilter == nil ||
		*fake.preferencesPatch.LibraryFilter != "favorites" || fake.preferencesPatch.LibrarySort != nil ||
		!strings.Contains(response.Body.String(), `"libraryFilter":"favorites"`) {
		t.Fatalf("put preferences: %d %s", response.Code, response.Body.String())
	}
	// Only the sort: the filter is left as it was saved.
	request = httptest.NewRequest(http.MethodPut, "/api/account/preferences", strings.NewReader(`{"librarySort":"composer"}`))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.preferencesPatch.LibraryFilter != nil ||
		fake.preferencesPatch.LibrarySort == nil || *fake.preferencesPatch.LibrarySort != "composer" ||
		!strings.Contains(response.Body.String(), `"librarySort":"composer"`) {
		t.Fatalf("put sort preference: %d %s", response.Code, response.Body.String())
	}
	request = httptest.NewRequest(http.MethodPut, "/api/account/preferences", strings.NewReader(`{"theme":"dark"}`))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown preference: %d %s", response.Code, response.Body.String())
	}
}

func TestCreateAndPatchPassStatus(t *testing.T) {
	fake := &fakeBackend{}
	router := testRouter(fake, 1024)
	request := httptest.NewRequest(http.MethodPost, "/api/pieces/", strings.NewReader(`{"title":"Prelude","status":"learning"}`))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || fake.createInput.Status == nil || *fake.createInput.Status != "learning" {
		t.Fatalf("create: %d %+v", response.Code, fake.createInput)
	}
	request = httptest.NewRequest(http.MethodPatch, "/api/pieces/"+testPieceID+"/", strings.NewReader(`{"status":"shelved"}`))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.patchInput.Status == nil || *fake.patchInput.Status != "shelved" {
		t.Fatalf("patch: %d %+v", response.Code, fake.patchInput)
	}
}

func TestReaderStateChecksumConflictReturns409(t *testing.T) {
	fake := &fakeBackend{readerError: app.ErrPDFChanged}
	checksum := strings.Repeat("a", 64)
	request := httptest.NewRequest(
		http.MethodPut,
		"/api/pieces/"+testPieceID+"/reader-state",
		strings.NewReader(`{"pieceId":"`+testPieceID+`","pdfChecksumSha256":"`+checksum+`","mode":"page","lastPage":2,"scrollPosition":0,"zoom":1,"scrollSpeed":5,"scrollPaused":true}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)

	if response.Code != http.StatusConflict ||
		!strings.Contains(response.Body.String(), "score PDF changed") {
		t.Fatalf("expected PDF conflict, got %d %s", response.Code, response.Body.String())
	}
	if fake.readerState.PDFChecksumSHA256 != checksum || fake.readerState.LastPage != 2 {
		t.Fatalf("reader state checksum was not passed to the backend: %+v", fake.readerState)
	}
}

func TestCreateAndPatchPassListeningURL(t *testing.T) {
	fake := &fakeBackend{}
	createBody := strings.NewReader(`{
		"title":"Prelude","sourceUrl":"https://scores.example.test/prelude",
		"listeningUrl":"https://listen.example.test/prelude"
	}`)
	createRequest := httptest.NewRequest(http.MethodPost, "/api/pieces/", createBody)
	createResponse := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(createResponse, createRequest)
	if createResponse.Code != http.StatusCreated || fake.createUserID != testUserID ||
		fake.createInput.ListeningURL != "https://listen.example.test/prelude" ||
		fake.createInput.SourceURL != "https://scores.example.test/prelude" ||
		!strings.Contains(createResponse.Body.String(), `"listeningUrl":"https://listen.example.test/prelude"`) {
		t.Fatalf("create did not preserve distinct URLs: status=%d input=%+v body=%s",
			createResponse.Code, fake.createInput, createResponse.Body.String())
	}

	patchRequest := httptest.NewRequest(
		http.MethodPatch,
		"/api/pieces/"+testPieceID+"/",
		strings.NewReader(`{"listeningUrl":"https://listen.example.test/revised"}`),
	)
	patchResponse := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(patchResponse, patchRequest)
	if patchResponse.Code != http.StatusOK || fake.patchUserID != testUserID ||
		fake.patchPieceID != testPieceID || fake.patchInput.ListeningURL == nil ||
		*fake.patchInput.ListeningURL != "https://listen.example.test/revised" {
		t.Fatalf("patch did not preserve listening URL: status=%d patch=%+v body=%s",
			patchResponse.Code, fake.patchInput, patchResponse.Body.String())
	}
}

func TestCreateReturnsListeningURLValidationError(t *testing.T) {
	fake := &fakeBackend{createErr: &app.ValidationError{Message: "listening URL must be an http or https URL"}}
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/pieces/",
		strings.NewReader(`{"title":"Prelude","listeningUrl":"file:///tmp/recording.mp3"}`),
	)
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), "listening URL must be an http or https URL") {
		t.Fatalf("expected listening URL validation failure, got %d %s", response.Code, response.Body.String())
	}
}

func TestCreateAndPatchMusicalMetadata(t *testing.T) {
	fake := &fakeBackend{}
	router := testRouter(fake, 1024)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/pieces/", strings.NewReader(`{"title":"Study","opus":"Op. 10","musicKey":"C♯ minor"}`)))
	if response.Code != http.StatusCreated || fake.createUserID != testUserID || fake.createInput.Opus != "Op. 10" || fake.createInput.MusicKey != "C♯ minor" {
		t.Fatal("create metadata", response.Code, fake.createInput)
	}
	for _, body := range []string{`{"opus":"","musicKey":""}`, `{"notes":"Keep metadata"}`} {
		response = httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPatch, "/api/pieces/"+testPieceID+"/", strings.NewReader(body)))
		if response.Code != http.StatusOK || fake.patchUserID != testUserID {
			t.Fatal("patch metadata", response.Code)
		}
		if strings.Contains(body, "notes") {
			if fake.patchInput.Opus != nil || fake.patchInput.MusicKey != nil {
				t.Fatal("missing fields became clears")
			}
		} else if fake.patchInput.Opus == nil || *fake.patchInput.Opus != "" || fake.patchInput.MusicKey == nil || *fake.patchInput.MusicKey != "" {
			t.Fatal("explicit clear lost")
		}
	}
}
