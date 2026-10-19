package httpapi

import (
	"context"
	"net/http"

	"github.com/bitofbytes-io/noted/internal/app"
)

type preferencesBackend interface {
	GetPreferences(context.Context, string) (app.Preferences, error)
	PutPreferences(context.Context, string, app.PreferencesPatch) (app.Preferences, error)
}

// The router finds preferences by type assertion, so a signature drift must fail the build.
var _ preferencesBackend = (*app.Service)(nil)

func (h *Handler) preferences(w http.ResponseWriter) (preferencesBackend, bool) {
	backend, ok := h.backend.(preferencesBackend)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "preferences are unavailable")
	}
	return backend, ok
}

func (h *Handler) getPreferences(w http.ResponseWriter, r *http.Request) {
	backend, ok := h.preferences(w)
	if !ok {
		return
	}
	preferences, err := backend.GetPreferences(r.Context(), currentUser(r).ID)
	if err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preferences)
}

func (h *Handler) putPreferences(w http.ResponseWriter, r *http.Request) {
	backend, ok := h.preferences(w)
	if !ok {
		return
	}
	// Preferences left out of the body keep their saved value.
	var patch app.PreferencesPatch
	if err := decodeJSON(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	preferences, err := backend.PutPreferences(r.Context(), currentUser(r).ID, patch)
	if err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preferences)
}
