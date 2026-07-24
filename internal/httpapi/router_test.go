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
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
)

const testPieceID = "4f607127-fb97-4b22-90f5-1b9bec77b739"

type fakeBackend struct {
	listQuery    string
	listFavorite *bool
	uploadName   string
	uploadBody   string
}

func (fake *fakeBackend) ListPieces(_ context.Context, query string, favorite *bool) ([]app.Piece, error) {
	fake.listQuery, fake.listFavorite = query, favorite
	return []app.Piece{}, nil
}
func (*fakeBackend) GetPiece(context.Context, string) (app.Piece, error) {
	return app.Piece{ID: testPieceID}, nil
}
func (*fakeBackend) CreatePiece(context.Context, app.PieceInput) (app.Piece, error) {
	return app.Piece{ID: testPieceID}, nil
}
func (*fakeBackend) UpdatePiece(context.Context, string, app.PiecePatch) (app.Piece, error) {
	return app.Piece{ID: testPieceID}, nil
}
func (*fakeBackend) DeletePiece(context.Context, string) error { return nil }
func (fake *fakeBackend) UploadPDF(_ context.Context, _ string, name string, _ int, body io.Reader) (app.Piece, error) {
	content, err := io.ReadAll(body)
	fake.uploadName, fake.uploadBody = name, string(content)
	return app.Piece{ID: testPieceID}, err
}
func (*fakeBackend) PDFSource(context.Context, string) (app.PDFSource, assets.ReadSeekCloser, error) {
	body := &seekReadCloser{Reader: bytes.NewReader([]byte("0123456789"))}
	return app.PDFSource{OriginalFilename: "score.pdf", UploadedAt: time.Unix(1, 0)}, body, nil
}
func (*fakeBackend) GetReaderState(context.Context, string) (app.ReaderState, error) {
	return app.ReaderState{PieceID: testPieceID, Mode: "page", LastPage: 1, Zoom: 1, ScrollSpeed: 32}, nil
}
func (*fakeBackend) PutReaderState(_ context.Context, _ string, state app.ReaderState) (app.ReaderState, error) {
	return state, nil
}

type seekReadCloser struct{ *bytes.Reader }

func (*seekReadCloser) Close() error { return nil }

func TestListPassesSearchAndFavoriteFilters(t *testing.T) {
	fake := &fakeBackend{}
	request := httptest.NewRequest(http.MethodGet, "/api/pieces/?q=bach&favorite=true", nil)
	response := httptest.NewRecorder()
	NewRouter(fake, 1024, "").ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.listQuery != "bach" ||
		fake.listFavorite == nil || !*fake.listFavorite {
		t.Fatalf("filters not passed: status=%d query=%q favorite=%v", response.Code, fake.listQuery, fake.listFavorite)
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
	NewRouter(fake, 1024, "").ServeHTTP(response, request)
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
	NewRouter(&fakeBackend{}, 1024, "").ServeHTTP(response, request)
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
	NewRouter(&fakeBackend{}, 8, "").ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected size failure, got %d %s", response.Code, response.Body.String())
	}
}

func TestPDFSupportsRanges(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/pieces/"+testPieceID+"/pdf", nil)
	request.Header.Set("Range", "bytes=2-5")
	response := httptest.NewRecorder()
	NewRouter(&fakeBackend{}, 1024, "").ServeHTTP(response, request)
	if response.Code != http.StatusPartialContent || response.Body.String() != "2345" {
		t.Fatalf("unexpected range response: %d %q", response.Code, response.Body.String())
	}
}
