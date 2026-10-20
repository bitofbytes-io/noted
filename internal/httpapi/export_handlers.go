package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
)

const exportTimeout = 5 * time.Minute

type exportBackend interface {
	ExportLibrary(context.Context, string, io.Writer) error
}

var _ exportBackend = (*app.Service)(nil)

func (h *Handler) exportLibrary(w http.ResponseWriter, r *http.Request) {
	backend, ok := h.backend.(exportBackend)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "library export unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), exportTimeout)
	defer cancel()
	controller := http.NewResponseController(w)
	deadline, _ := ctx.Deadline()
	if err := controller.SetWriteDeadline(deadline); err != nil {
		writeError(w, http.StatusServiceUnavailable, "library export unavailable")
		return
	}
	defer func() {
		if err := controller.SetWriteDeadline(time.Time{}); err != nil {
			slog.Warn("resetting export write deadline failed")
		}
	}()
	output := &exportResponse{writer: w, controller: controller}
	if err := backend.ExportLibrary(ctx, currentUser(r).ID, output); err != nil {
		// Do not log errors containing filesystem paths, SQL, titles, or keys.
		if output.started {
			slog.Warn("library export interrupted")
			panic(http.ErrAbortHandler)
		}
		var limited *app.ExportLimitError
		if errors.As(err, &limited) {
			w.Header().Set("Retry-After", strconv.Itoa(max(1, int(math.Ceil(limited.RetryAfter.Seconds())))))
			writeError(w, http.StatusTooManyRequests, "library export limit reached")
			return
		}
		writeError(w, http.StatusInternalServerError, "library export failed")
	}
}

type exportResponse struct {
	writer     http.ResponseWriter
	controller *http.ResponseController
	started    bool
}

func (w *exportResponse) Write(data []byte) (int, error) {
	if !w.started {
		w.started = true
		h := w.writer.Header()
		h.Set("Content-Type", "application/zip")
		h.Set("Content-Disposition", `attachment; filename="noted-library.zip"`)
		h.Set("Cache-Control", "private, no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Del("Content-Length")
	}
	n, err := w.writer.Write(data)
	if err == nil {
		err = w.controller.Flush()
	}
	return n, err
}
