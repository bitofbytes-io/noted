package app

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const validRemoteMusicXML = `<score-partwise><part><measure><note><pitch><step>C</step><octave>4</octave></pitch></note></measure></part></score-partwise>`

func TestHTTPRecognizerStreamsPDFAndPersistsValidatedMusicXML(t *testing.T) {
	input := writeRecognitionInput(t, []byte("%PDF-1.7\nscore"))
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/recognize" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer secret-token" {
			t.Fatalf("authorization header was not sent")
		}
		if request.ContentLength != -1 {
			t.Fatalf("multipart request was buffered; content length = %d", request.ContentLength)
		}
		file, header, err := request.FormFile("file")
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		if header.Filename != filepath.Base(input) {
			t.Fatalf("uploaded filename = %q", header.Filename)
		}
		contents, err := io.ReadAll(file)
		if err != nil {
			t.Fatal(err)
		}
		if string(contents) != "%PDF-1.7\nscore" {
			t.Fatalf("uploaded PDF = %q", contents)
		}
		response.Header().Set("Content-Type", "application/vnd.recordare.musicxml+xml")
		response.Header().Set("X-Noted-OMR-Engine", "audiveris")
		response.Header().Set("X-Noted-OMR-Version", "5.10.2")
		_, _ = io.WriteString(response, validRemoteMusicXML)
	}))
	defer server.Close()

	outputDirectory := t.TempDir()
	result, err := (HTTPRecognizer{BaseURL: server.URL, Token: "secret-token"}).Recognize(context.Background(), input, outputDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if result.EngineVersion != "5.10.2" || filepath.Ext(result.Path) != ".musicxml" {
		t.Fatalf("recognition result = %+v", result)
	}
	contents, err := os.ReadFile(result.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != validRemoteMusicXML {
		t.Fatalf("persisted output = %q", contents)
	}
}

func TestHTTPRecognizerAcceptsValidatedMXL(t *testing.T) {
	mxl := compressedRemoteMusicXML(t)
	server := recognitionResponseServer(t, http.StatusOK, "application/vnd.recordare.musicxml", mxl)
	defer server.Close()
	result, err := (HTTPRecognizer{BaseURL: server.URL, Token: "token"}).Recognize(context.Background(), writeRecognitionInput(t, []byte("%PDF-1.7")), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Ext(result.Path) != ".mxl" {
		t.Fatalf("output path = %q", result.Path)
	}
}

func TestHTTPRecognizerPersistsLinkedMusicXMLAndOMRProject(t *testing.T) {
	project := compressedRemoteOMR(t)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("X-Noted-OMR-Engine", "audiveris")
		response.Header().Set("X-Noted-OMR-Version", "5.10.2")
		writer := multipart.NewWriter(response)
		response.Header().Set("Content-Type", "multipart/mixed; boundary="+writer.Boundary())
		scoreHeader := make(textproto.MIMEHeader)
		scoreHeader.Set("Content-Type", "application/vnd.recordare.musicxml+xml")
		scoreHeader.Set("X-Noted-Artifact", "score")
		score, _ := writer.CreatePart(scoreHeader)
		_, _ = io.WriteString(score, validRemoteMusicXML)
		projectHeader := make(textproto.MIMEHeader)
		projectHeader.Set("Content-Type", "application/octet-stream")
		projectHeader.Set("X-Noted-Artifact", "project")
		projectPart, _ := writer.CreatePart(projectHeader)
		_, _ = projectPart.Write(project)
		_ = writer.Close()
	}))
	defer server.Close()

	result, err := (HTTPRecognizer{BaseURL: server.URL, Token: "token"}).Recognize(
		context.Background(), writeRecognitionInput(t, []byte("%PDF-1.7")), t.TempDir(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Ext(result.Path) != ".musicxml" || filepath.Ext(result.ProjectPath) != ".omr" {
		t.Fatalf("recognition result = %+v", result)
	}
	storedProject, err := os.ReadFile(result.ProjectPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(storedProject, project) {
		t.Fatal("stored correction project differs from the worker artifact")
	}
}

func TestHTTPRecognizerRejectsAndRemovesInvalidOrOversizedOutput(t *testing.T) {
	for _, test := range []struct {
		name        string
		contentType string
		body        []byte
		want        string
	}{
		{name: "invalid XML", contentType: "application/vnd.recordare.musicxml+xml", body: []byte("not xml"), want: "unusable MusicXML"},
		{name: "unsupported type", contentType: "text/plain", body: []byte(validRemoteMusicXML), want: "unsupported content type"},
		{name: "oversized", contentType: "application/vnd.recordare.musicxml+xml", body: bytes.Repeat([]byte("x"), maxRecognitionOutputBytes+1), want: "too large"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := recognitionResponseServer(t, http.StatusOK, test.contentType, test.body)
			defer server.Close()
			outputDirectory := t.TempDir()
			_, err := (HTTPRecognizer{BaseURL: server.URL, Token: "token"}).Recognize(context.Background(), writeRecognitionInput(t, []byte("%PDF-1.7")), outputDirectory)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("recognition error = %v, want %q", err, test.want)
			}
			entries, readErr := os.ReadDir(outputDirectory)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if len(entries) != 0 {
				t.Fatalf("failed output was retained: %v", entries)
			}
		})
	}
}

func TestHTTPRecognizerReturnsBoundedWorkerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(response, `{"error":{"code":"busy","message":"worker is busy"}}`)
	}))
	defer server.Close()
	_, err := (HTTPRecognizer{BaseURL: server.URL, Token: "token", MaxAttempts: 1}).Recognize(context.Background(), writeRecognitionInput(t, []byte("%PDF-1.7")), t.TempDir())
	var remoteErr *RemoteRecognitionError
	if !errors.As(err, &remoteErr) {
		t.Fatalf("recognition error = %T %v", err, err)
	}
	if remoteErr.StatusCode != http.StatusTooManyRequests || remoteErr.Code != "busy" || remoteErr.Message != "worker is busy" {
		t.Fatalf("remote error = %+v", remoteErr)
	}
}

func TestHTTPRecognizerRetriesBusyWorkerWithBoundedBackoff(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		file, _, err := request.FormFile("file")
		if err != nil {
			t.Fatal(err)
		}
		_ = file.Close()
		if attempts.Add(1) < 3 {
			response.Header().Set("Content-Type", "application/json")
			response.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(response, `{"error":{"code":"busy","message":"worker is busy"}}`)
			return
		}
		response.Header().Set("Content-Type", "application/vnd.recordare.musicxml+xml")
		response.Header().Set("X-Noted-OMR-Engine", "audiveris")
		response.Header().Set("X-Noted-OMR-Version", "5.10.2")
		_, _ = io.WriteString(response, validRemoteMusicXML)
	}))
	defer server.Close()

	result, err := (HTTPRecognizer{
		BaseURL: server.URL, Token: "token", MaxAttempts: 3, InitialRetryDelay: time.Millisecond,
	}).Recognize(context.Background(), writeRecognitionInput(t, []byte("%PDF-1.7")), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if attempts.Load() != 3 || result.EngineVersion != "5.10.2" {
		t.Fatalf("attempts = %d, result = %+v", attempts.Load(), result)
	}
}

func TestHTTPRecognizerRequiresEngineMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/vnd.recordare.musicxml+xml")
		_, _ = io.WriteString(response, validRemoteMusicXML)
	}))
	defer server.Close()
	_, err := (HTTPRecognizer{BaseURL: server.URL, Token: "token"}).Recognize(context.Background(), writeRecognitionInput(t, []byte("%PDF-1.7")), t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "engine metadata") {
		t.Fatalf("recognition error = %v", err)
	}
}

func TestHTTPRecognizerDoesNotFollowRedirectsWithBearerToken(t *testing.T) {
	redirectReached := false
	target := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		redirectReached = true
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		http.Redirect(response, httptest.NewRequest(http.MethodGet, "/", nil), target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()

	_, err := (HTTPRecognizer{BaseURL: server.URL, Token: "token"}).Recognize(context.Background(), writeRecognitionInput(t, []byte("%PDF-1.7")), t.TempDir())
	var remoteErr *RemoteRecognitionError
	if !errors.As(err, &remoteErr) || remoteErr.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("recognition error = %T %v", err, err)
	}
	if redirectReached {
		t.Fatal("recognition client followed a redirect with its bearer token")
	}
}

func recognitionResponseServer(t *testing.T, status int, contentType string, body []byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer token" {
			t.Fatalf("authorization header was not sent")
		}
		response.Header().Set("Content-Type", contentType)
		response.Header().Set("X-Noted-OMR-Engine", "audiveris")
		response.Header().Set("X-Noted-OMR-Version", "5.10.2")
		response.WriteHeader(status)
		_, _ = response.Write(body)
	}))
}

func writeRecognitionInput(t *testing.T, contents []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "input.pdf")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func compressedRemoteMusicXML(t *testing.T) []byte {
	t.Helper()
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	entry, err := archive.Create("score.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(entry, validRemoteMusicXML); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func compressedRemoteOMR(t *testing.T) []byte {
	t.Helper()
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	entry, err := archive.Create("book.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(entry, `<book/>`); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}
