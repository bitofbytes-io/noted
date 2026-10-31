package httpapi

import (
	"bytes"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bitofbytes-io/noted/internal/app"
)

// A piece's PDF is replaced only through Prepare; the PDF route is read-only.
func TestPDFRouteRejectsDirectUpload(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/pieces/"+testPieceID+"/pdf", strings.NewReader("%PDF-"))
	response := httptest.NewRecorder()
	testRouter(&fakeBackend{}, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("direct PDF upload: %d %s", response.Code, response.Body.String())
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
