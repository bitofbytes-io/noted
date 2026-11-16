package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"

	"github.com/bitofbytes-io/noted/internal/app"
)

var errUploadTooLarge = errors.New("upload exceeds configured limit")

type hardLimitReader struct {
	reader io.Reader
	left   int64
}

func (reader *hardLimitReader) Read(buffer []byte) (int, error) {
	if reader.left < 0 {
		return 0, errUploadTooLarge
	}
	limit := int64(len(buffer))
	if limit > reader.left+1 {
		limit = reader.left + 1
	}
	count, err := reader.reader.Read(buffer[:limit])
	reader.left -= int64(count)
	if reader.left < 0 {
		return count, errUploadTooLarge
	}
	return count, err
}

func decodeJSON(request *http.Request, destination any) error {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("request must contain one JSON object")
	}
	return nil
}

func handleError(writer http.ResponseWriter, err error) {
	var invalid *app.ValidationError
	switch {
	case errors.Is(err, app.ErrComposerChanged), errors.Is(err, app.ErrConflict), errors.Is(err, app.ErrPieceChanged), errors.Is(err, app.ErrPDFChanged):
		writeError(writer, http.StatusConflict, err.Error())
	case errors.Is(err, app.ErrImportLimit):
		writeError(writer, http.StatusRequestEntityTooLarge, "Import limit reached: max 20 drafts, 200 MiB per draft, and configured per-file limit")
	case errors.Is(err, app.ErrNotFound):
		writeError(writer, http.StatusNotFound, "piece not found")
	case errors.As(err, &invalid):
		if invalid.Cause != nil {
			slog.Info("request rejected", "reason", invalid.Message, "cause", invalid.Cause)
		}
		writeError(writer, http.StatusBadRequest, invalid.Message)
	default:
		slog.Error("request failed", "error", err)
		writeError(writer, http.StatusInternalServerError, "internal server error")
	}
}

func writeError(writer http.ResponseWriter, status int, message string) {
	writeJSONStatus(writer, status, map[string]string{"error": message})
}

func writeJSON(writer http.ResponseWriter, status int, body any) {
	writeJSONStatus(writer, status, body)
}

func writeJSONStatus(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(body); err != nil {
		// Headers may already be sent; never append a second response or log private data.
		slog.Warn("writing JSON response failed")
	}
}
