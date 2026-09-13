package httpapi

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/bitofbytes-io/noted/internal/config"
)

const testPieceID = "4f607127-fb97-4b22-90f5-1b9bec77b739"
const testUserID = "db53bb2a-b720-407a-8941-cd4459f69e79"

type fakeBackend struct {
	listQuery    string
	listFavorite *bool
	listUserID   string
	createInput  app.PieceInput
	createUserID string
	createErr    error
	patchInput   app.PiecePatch
	patchUserID  string
	patchPieceID string
	uploadName   string
	uploadBody   string
	pdfFilename  string
	pdfBody      []byte
	pdfError     error
	pdfUserID    string
	pdfPieceID   string
}

func (fake *fakeBackend) ListPieces(_ context.Context, userID, query string, favorite *bool) ([]app.Piece, error) {
	fake.listUserID, fake.listQuery, fake.listFavorite = userID, query, favorite
	return []app.Piece{}, nil
}
func (*fakeBackend) GetPiece(context.Context, string, string) (app.Piece, error) {
	return app.Piece{ID: testPieceID}, nil
}
func (fake *fakeBackend) CreatePiece(_ context.Context, userID string, input app.PieceInput) (app.Piece, error) {
	fake.createUserID, fake.createInput = userID, input
	return app.Piece{ID: testPieceID, ListeningURL: input.ListeningURL}, fake.createErr
}
func (fake *fakeBackend) UpdatePiece(_ context.Context, userID, pieceID string, patch app.PiecePatch) (app.Piece, error) {
	fake.patchUserID, fake.patchPieceID, fake.patchInput = userID, pieceID, patch
	piece := app.Piece{ID: testPieceID}
	if patch.ListeningURL != nil {
		piece.ListeningURL = *patch.ListeningURL
	}
	return piece, nil
}
func (*fakeBackend) DeletePiece(context.Context, string, string) error { return nil }
func (fake *fakeBackend) UploadPDF(_ context.Context, _, _ string, name string, _ int, body io.Reader) (app.Piece, error) {
	content, err := io.ReadAll(body)
	fake.uploadName, fake.uploadBody = name, string(content)
	return app.Piece{ID: testPieceID}, err
}
func (fake *fakeBackend) PDFSource(
	_ context.Context,
	userID, pieceID string,
) (app.PDFSource, assets.ReadSeekCloser, error) {
	fake.pdfUserID, fake.pdfPieceID = userID, pieceID
	if fake.pdfError != nil {
		return app.PDFSource{}, nil, fake.pdfError
	}
	filename := fake.pdfFilename
	if filename == "" {
		filename = "score.pdf"
	}
	body := fake.pdfBody
	if body == nil {
		body = []byte("0123456789")
	}
	reader := &seekReadCloser{Reader: bytes.NewReader(body)}
	return app.PDFSource{OriginalFilename: filename, UploadedAt: time.Unix(1, 0)}, reader, nil
}
func (*fakeBackend) GetReaderState(context.Context, string, string) (app.ReaderState, error) {
	return app.ReaderState{PieceID: testPieceID, Mode: "page", LastPage: 1, Zoom: 1, ScrollSpeed: 32}, nil
}
func (*fakeBackend) PutReaderState(_ context.Context, _, _ string, state app.ReaderState) (app.ReaderState, error) {
	return state, nil
}

type fakeAuthenticator struct{}

func (*fakeAuthenticator) EnsureDevelopmentUser(context.Context, string) (app.User, error) {
	return app.User{ID: testUserID, Email: "learner@noted.local", DisplayName: "Learner"}, nil
}
func (*fakeAuthenticator) NewLoginState(context.Context, string) (string, error) {
	return "state", nil
}
func (*fakeAuthenticator) ConsumeLoginState(context.Context, string) (string, error) {
	return "/", nil
}
func (*fakeAuthenticator) AuthenticateGoogle(context.Context, auth.GoogleIdentity) (app.User, error) {
	return app.User{ID: testUserID}, nil
}
func (*fakeAuthenticator) NewSession(context.Context, string, string, string) (string, time.Time, error) {
	return "token", time.Now().Add(time.Hour), nil
}
func (*fakeAuthenticator) ResolveSession(context.Context, string) (app.User, error) {
	return app.User{ID: testUserID}, nil
}
func (*fakeAuthenticator) DeleteSession(context.Context, string) error { return nil }

func testRouter(backend Backend, maxUploadBytes int64) http.Handler {
	return NewRouter(backend, &fakeAuthenticator{}, config.Config{
		AppEnv: "test", AuthMode: "development", DevUserEmail: "learner@noted.local",
		MaxUploadBytes: maxUploadBytes,
	})
}

type seekReadCloser struct{ *bytes.Reader }

func (*seekReadCloser) Close() error { return nil }

func TestListPassesSearchAndFavoriteFilters(t *testing.T) {
	fake := &fakeBackend{}
	request := httptest.NewRequest(http.MethodGet, "/api/pieces/?q=bach&favorite=true", nil)
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.listQuery != "bach" ||
		fake.listUserID != testUserID || fake.listFavorite == nil || !*fake.listFavorite {
		t.Fatalf("filters not passed: status=%d query=%q favorite=%v", response.Code, fake.listQuery, fake.listFavorite)
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
	fake := &fakeBackend{createErr: errors.New("listening URL must be an http or https URL")}
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

func TestUploadValidatesSignatureAndSanitizesFilename(t *testing.T) {
	fake := &fakeBackend{}
	body := &bytes.Buffer{}
	form := multipart.NewWriter(body)
	_ = form.WriteField("pageCount", "2")
	file, _ := form.CreateFormFile("file", `..\..\unsafe.pdf`)
	_, _ = io.WriteString(file, "%PDF-safe")
	_ = form.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/pieces/"+testPieceID+"/pdf", body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
	if fake.uploadName != "unsafe.pdf" || fake.uploadBody != "%PDF-safe" {
		t.Fatalf("unsafe upload handling: name=%q body=%q", fake.uploadName, fake.uploadBody)
	}
}

func TestUploadRejectsNonPDF(t *testing.T) {
	body := &bytes.Buffer{}
	form := multipart.NewWriter(body)
	_ = form.WriteField("pageCount", "1")
	file, _ := form.CreateFormFile("file", "fake.pdf")
	_, _ = io.WriteString(file, "not a pdf")
	_ = form.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/pieces/"+testPieceID+"/pdf", body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	response := httptest.NewRecorder()
	testRouter(&fakeBackend{}, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "valid PDF") {
		t.Fatalf("expected validation failure, got %d %s", response.Code, response.Body.String())
	}
}

func TestUploadRejectsFilesOverConfiguredLimit(t *testing.T) {
	body := &bytes.Buffer{}
	form := multipart.NewWriter(body)
	_ = form.WriteField("pageCount", "1")
	file, _ := form.CreateFormFile("file", "large.pdf")
	_, _ = io.WriteString(file, "%PDF-more-than-eight-bytes")
	_ = form.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/pieces/"+testPieceID+"/pdf", body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	response := httptest.NewRecorder()
	testRouter(&fakeBackend{}, 8).ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected size failure, got %d %s", response.Code, response.Body.String())
	}
}

func TestPDFSupportsRanges(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/pieces/"+testPieceID+"/pdf", nil)
	request.Header.Set("Range", "bytes=2-5")
	response := httptest.NewRecorder()
	testRouter(&fakeBackend{}, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusPartialContent || response.Body.String() != "2345" {
		t.Fatalf("unexpected range response: %d %q", response.Code, response.Body.String())
	}
	if disposition := response.Header().Get("Content-Disposition"); disposition != `inline; filename=score.pdf` {
		t.Fatalf("Content-Disposition = %q, want inline filename", disposition)
	}
	if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "private, max-age=0, must-revalidate" {
		t.Fatalf("Cache-Control = %q", cacheControl)
	}
}

func TestPDFDownloadServesExactBytesAsSafeAttachment(t *testing.T) {
	wantBody := []byte("%PDF-current-score")
	fake := &fakeBackend{pdfFilename: `../../Daniel's cleaned score.pdf`, pdfBody: wantBody}
	request := httptest.NewRequest(http.MethodGet, "/api/pieces/"+testPieceID+"/pdf/download", nil)
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
	if !bytes.Equal(response.Body.Bytes(), wantBody) {
		t.Fatalf("download body = %q, want %q", response.Body.Bytes(), wantBody)
	}
	mediaType, parameters, err := mime.ParseMediaType(response.Header().Get("Content-Disposition"))
	if err != nil {
		t.Fatalf("parse Content-Disposition: %v", err)
	}
	if mediaType != "attachment" || parameters["filename"] != "Daniel's cleaned score.pdf" {
		t.Fatalf("Content-Disposition = %q", response.Header().Get("Content-Disposition"))
	}
	if response.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("Content-Type = %q", response.Header().Get("Content-Type"))
	}
	if response.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("Accept-Ranges = %q", response.Header().Get("Accept-Ranges"))
	}
	if response.Header().Get("Cache-Control") != "private, max-age=0, must-revalidate" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
	if fake.pdfUserID != testUserID || fake.pdfPieceID != testPieceID {
		t.Fatalf("PDFSource called with user=%q piece=%q", fake.pdfUserID, fake.pdfPieceID)
	}
}

func TestPDFDownloadSupportsHead(t *testing.T) {
	request := httptest.NewRequest(http.MethodHead, "/api/pieces/"+testPieceID+"/pdf/download", nil)
	response := httptest.NewRecorder()
	testRouter(&fakeBackend{}, 1024).ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Body.Len() != 0 {
		t.Fatalf("unexpected HEAD response: %d body=%q", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Length") != "10" {
		t.Fatalf("Content-Length = %q, want 10", response.Header().Get("Content-Length"))
	}
	if disposition := response.Header().Get("Content-Disposition"); disposition != `attachment; filename=score.pdf` {
		t.Fatalf("Content-Disposition = %q, want attachment filename", disposition)
	}
}

func TestPDFDownloadReturnsUniformNotFoundForUnavailablePiece(t *testing.T) {
	fake := &fakeBackend{pdfError: app.ErrNotFound}
	request := httptest.NewRequest(http.MethodGet, "/api/pieces/"+testPieceID+"/pdf/download", nil)
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)

	if response.Code != http.StatusNotFound || response.Body.String() != "{\"error\":\"piece not found\"}\n" {
		t.Fatalf("unexpected not-found response: %d %q", response.Code, response.Body.String())
	}
	if fake.pdfUserID != testUserID || fake.pdfPieceID != testPieceID {
		t.Fatalf("PDFSource called with user=%q piece=%q", fake.pdfUserID, fake.pdfPieceID)
	}
}

func TestChangedPieceConflictGuidance(t *testing.T) {
	response := httptest.NewRecorder()
	handleError(response, app.ErrPieceChanged)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "draft is retained") || !strings.Contains(response.Body.String(), "Start a new preparation") || strings.Contains(response.Body.String(), "reload") {
		t.Fatalf("stale piece guidance: %d %s", response.Code, response.Body.String())
	}
}
