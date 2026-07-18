package httptransport

import (
	"bytes"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/config"
)

func multipartRequest(t *testing.T, filename string, content []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("sourceUrl", "https://example.test/score"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("rightsNote", "CC0 fixture"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "/api/editions/edition/assets", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func TestParsePracticeFilters(t *testing.T) {
	request := httptest.NewRequest("GET", "/api/practice-sessions?workId=work-1&from=2034-03-05T09%3A00%3A00Z&to=2034-03-06T09%3A00%3A00Z", nil)
	filters, err := parsePracticeFilters(request)
	if err != nil {
		t.Fatal(err)
	}
	if filters.WorkID != "work-1" || filters.From == nil || filters.To == nil {
		t.Fatalf("parsed filters = %+v", filters)
	}
	if want := time.Date(2034, time.March, 5, 9, 0, 0, 0, time.UTC); !filters.From.Equal(want) {
		t.Fatalf("from = %v, want %v", filters.From, want)
	}
}

func TestParsePracticeFiltersRejectsInvalidOrReversedDates(t *testing.T) {
	for name, target := range map[string]string{
		"invalid":  "/api/practice-sessions?from=March-5",
		"reversed": "/api/practice-sessions?from=2034-03-06T09%3A00%3A00Z&to=2034-03-05T09%3A00%3A00Z",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := parsePracticeFilters(httptest.NewRequest("GET", target, nil))
			if err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestReadMultipartUploadStreamsFileAndCleansStagingFile(t *testing.T) {
	handler := Handler{Config: config.Config{MaxUploadBytes: 32}}
	header, file, metadata, err := handler.readMultipartUpload(multipartRequest(t, "score.pdf", []byte("%PDF-1.4 fixture")))
	if err != nil {
		t.Fatal(err)
	}
	staged, ok := file.(*stagedUpload)
	if !ok {
		t.Fatalf("upload type = %T, want *stagedUpload", file)
	}
	if header.Filename != "score.pdf" || header.Size != 16 {
		t.Fatalf("unexpected streamed file header: %+v", header)
	}
	if metadata.SourceURL != "https://example.test/score" || metadata.RightsNote != "CC0 fixture" {
		t.Fatalf("metadata after file part was not retained: %+v", metadata)
	}
	if _, err := os.Stat(staged.path); err != nil {
		t.Fatalf("staging file missing before close: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(staged.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging file remained after close: %v", err)
	}
}

func TestReadMultipartUploadRejectsOversizeAndCleansPartialFile(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("TMPDIR", tempDir)
	handler := Handler{Config: config.Config{MaxUploadBytes: 4}}
	_, _, _, err := handler.readMultipartUpload(multipartRequest(t, "score.pdf", []byte("12345")))
	if !errors.Is(err, errUploadTooLarge) {
		t.Fatalf("oversize upload error = %v, want %v", err, errUploadTooLarge)
	}
	entries, err := filepath.Glob(filepath.Join(tempDir, "noted-upload-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("oversize upload left partial staging files: %v", entries)
	}
}

func TestDownloadFilenamePreservesTheOriginalExtension(t *testing.T) {
	tests := []struct {
		displayName, originalName, want string
	}{
		{displayName: "Moonlight corrected", originalName: "recognized.mxl", want: "Moonlight corrected.mxl"},
		{displayName: "Moonlight.musicxml", originalName: "recognized.musicxml", want: "Moonlight.musicxml"},
		{displayName: "", originalName: "score.pdf", want: "score.pdf"},
	}
	for _, test := range tests {
		if got := downloadFilename(test.displayName, test.originalName); got != test.want {
			t.Errorf("downloadFilename(%q, %q) = %q, want %q", test.displayName, test.originalName, got, test.want)
		}
	}
	if got := safeFilename("folder/score\n.mxl"); got != "folder_score_.mxl" {
		t.Fatalf("safeFilename sanitized value = %q", got)
	}
}
