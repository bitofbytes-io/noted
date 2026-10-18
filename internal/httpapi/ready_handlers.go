package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
)

// readinessTimeout bounds the whole probe, so a stack healthcheck never waits
// on a dead database or a hung asset mount.
const readinessTimeout = 2 * time.Second

type readinessBackend interface {
	PingDatabase(context.Context) error
	CheckAssetStore(context.Context) error
}

// The router finds the readiness checks by type assertion, so a signature drift must fail the build.
var _ readinessBackend = (*app.Service)(nil)

// ready reports whether the API's dependencies answer. Unlike /api/health it
// fails with 503 when the database or the asset store does not; the body names
// the failing dependency but never the error, which can carry hosts or paths.
func (h *Handler) ready(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	backend, ok := h.backend.(readinessBackend)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]string{"status": "degraded", "db": "error", "assets": "error"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), readinessTimeout)
	defer cancel()
	// The checks run side by side so a slow database cannot spend the asset check's time.
	checks := map[string]func(context.Context) error{
		"db": backend.PingDatabase, "assets": backend.CheckAssetStore,
	}
	type result struct {
		name string
		err  error
	}
	results := make(chan result, len(checks))
	for name, check := range checks {
		go func() { results <- result{name, check(ctx)} }()
	}
	body := map[string]string{"status": "ok"}
	status := http.StatusOK
	for range checks {
		result := <-results
		body[result.name] = "ok"
		if result.err != nil {
			slog.Warn("readiness check failed", "dependency", result.name, "error", result.err)
			body[result.name] = "error"
			body["status"] = "degraded"
			status = http.StatusServiceUnavailable
		}
	}
	writeJSON(w, status, body)
}
