package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/bitofbytes-io/noted/internal/app"
)

type imslpBackend interface {
	SearchIMSLP(context.Context, string, string) (app.IMSLPSearch, error)
}

// The router finds IMSLP search by type assertion, so a signature drift must fail the build.
var _ imslpBackend = (*app.Service)(nil)

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
	result, err := backend.SearchIMSLP(r.Context(), currentUser(r).ID, query)
	w.Header().Set("Cache-Control", "private, no-store")
	switch {
	case errors.Is(err, app.ErrIMSLPThrottled):
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusTooManyRequests, app.IMSLPSearch{
			Status: app.IMSLPStatusThrottled, Results: []app.IMSLPWork{},
		})
	case err != nil && r.Context().Err() != nil:
		// The client cancelled this search for a newer one; nobody is waiting.
		return
	case err != nil:
		handleError(w, err)
	default:
		writeJSON(w, http.StatusOK, result)
	}
}
