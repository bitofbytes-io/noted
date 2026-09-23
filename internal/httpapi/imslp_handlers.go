package httpapi

import (
	"context"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/bitofbytes-io/noted/internal/app"
)

type imslpBackend interface {
	SearchIMSLP(context.Context, string) (app.IMSLPSearch, error)
}

func (h *Handler) searchIMSLPWorks(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(query) < 2 || utf8.RuneCountInString(query) > 100 {
		writeError(w, http.StatusBadRequest, "search must be 2 to 100 characters")
		return
	}
	backend, ok := h.backend.(imslpBackend)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "IMSLP search is unavailable")
		return
	}
	result, err := backend.SearchIMSLP(r.Context(), query)
	if err != nil {
		handleError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, http.StatusOK, result)
}
