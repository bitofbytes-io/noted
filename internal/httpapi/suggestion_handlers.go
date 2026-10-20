package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/jackc/pgx/v5/pgconn"
)

type SuggestionBackend interface {
	SuggestPieces(context.Context, string, app.ListOptions) ([]app.PieceSummary, error)
}

func (h *Handler) suggestPieces(w http.ResponseWriter, r *http.Request) {
	b, ok := h.backend.(SuggestionBackend)
	if !ok {
		writeError(w, 503, "similar matches unavailable")
		return
	}
	options := app.ListOptions{Query: r.URL.Query().Get("q")}
	if value := r.URL.Query().Get("favorite"); value != "" {
		favorite, err := strconv.ParseBool(value)
		if err != nil {
			writeError(w, 400, "favorite must be true or false")
			return
		}
		options.Favorite = &favorite
	}
	var err error
	options.Statuses, err = app.ParseStatusFilter(r.URL.Query().Get("status"), options.Query)
	if err != nil {
		handleError(w, err)
		return
	}
	pieces, err := b.SuggestPieces(r.Context(), currentUser(r).ID, options)
	if errors.Is(err, app.ErrSuggestionsThrottled) {
		w.Header().Set("Retry-After", "1")
		writeError(w, 429, "similar matches requested too quickly; try again shortly")
		return
	}
	var pgErr *pgconn.PgError
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) || (errors.As(err, &pgErr) && (pgErr.Code == "57014" || pgErr.Code == "55P03")) {
		writeError(w, 503, "similar matches temporarily unavailable; try again shortly")
		return
	}
	if err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, 200, pieces)
}
