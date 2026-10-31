package httpapi

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bitofbytes-io/noted/internal/app"
)

func TestChangedPieceConflictGuidance(t *testing.T) {
	response := httptest.NewRecorder()
	handleError(response, app.ErrPieceChanged)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "draft is retained") || !strings.Contains(response.Body.String(), "Start a new preparation") || strings.Contains(response.Body.String(), "reload") {
		t.Fatalf("stale piece guidance: %d %s", response.Code, response.Body.String())
	}
}

func TestTooManyPagesIsAValidationError(t *testing.T) {
	response := httptest.NewRecorder()
	handleError(response, app.ErrTooManyPages)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "up to 10 pages") {
		t.Fatalf("page limit response: %d %s", response.Code, response.Body.String())
	}
}

// The status comes from the error's type, never its wording.
func TestValidationStatusFollowsErrorType(t *testing.T) {
	for name, test := range map[string]struct {
		err    error
		status int
		body   string
	}{
		"validation": {&app.ValidationError{Message: "title must be between 1 and 300 characters"}, 400,
			`{"error":"title must be between 1 and 300 characters"}`},
		"wrapped validation": {fmt.Errorf("update draft: %w", &app.ValidationError{Message: "crop must have four normalized edges enclosing an area"}), 400,
			`{"error":"crop must have four normalized edges enclosing an area"}`},
		"library cause stays out": {&app.ValidationError{Message: "PDF must be readable and unencrypted", Cause: errors.New("pdfcpu: xreftable: corrupt object 12 0")}, 400,
			`{"error":"PDF must be readable and unencrypted"}`},
		"wording alone is not validation": {errors.New("database replica must be writable: cannot execute UPDATE"), 500,
			`{"error":"internal server error"}`},
	} {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			handleError(response, test.err)
			if response.Code != test.status || strings.TrimSpace(response.Body.String()) != test.body {
				t.Fatalf("%d %s", response.Code, response.Body.String())
			}
		})
	}
}

// A failed writer must not trigger another response or expose private payloads.
type failedJSONWriter struct {
	*httptest.ResponseRecorder
	writes int
}

func (w *failedJSONWriter) Write([]byte) (int, error) {
	w.writes++
	return 0, errors.New("private transport detail")
}

func TestWriteJSONStatusHandlesFailuresWithoutLeakingData(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	writer := &failedJSONWriter{ResponseRecorder: httptest.NewRecorder()}
	writeJSONStatus(writer, http.StatusCreated, map[string]string{"title": "private score title"})
	if writer.Code != http.StatusCreated || writer.writes != 1 || writer.Body.Len() != 0 {
		t.Fatalf("failed response: status=%d writes=%d body=%q", writer.Code, writer.writes, writer.Body.String())
	}
	recorder := httptest.NewRecorder()
	writeJSONStatus(recorder, http.StatusOK, make(chan int))
	if recorder.Code != http.StatusOK || recorder.Body.Len() != 0 {
		t.Fatalf("encoding failure appended a response: %d %q", recorder.Code, recorder.Body.String())
	}
	if strings.Count(logs.String(), "writing JSON response failed") != 2 || strings.Contains(logs.String(), "private") {
		t.Fatalf("unexpected failure logs: %s", logs.String())
	}
}
