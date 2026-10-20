package httpapi

import (
	"context"
	"github.com/bitofbytes-io/noted/internal/app"
	"net/http"
)

type ComposerBackend interface {
	ListComposers(context.Context, string) ([]app.ComposerEntry, error)
	PreviewComposerMerge(context.Context, string, app.ComposerMerge) (app.ComposerPreview, error)
	MergeComposers(context.Context, string, app.ComposerMerge) (app.ComposerPreview, error)
}

func (h *Handler) listComposers(w http.ResponseWriter, r *http.Request) {
	b, ok := h.backend.(ComposerBackend)
	if !ok {
		writeError(w, 503, "composer browsing unavailable")
		return
	}
	entries, err := b.ListComposers(r.Context(), currentUser(r).ID)
	if err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, 200, entries)
}
func (h *Handler) previewComposerMerge(w http.ResponseWriter, r *http.Request) {
	h.composerMerge(w, r, false)
}
func (h *Handler) mergeComposers(w http.ResponseWriter, r *http.Request) { h.composerMerge(w, r, true) }
func (h *Handler) composerMerge(w http.ResponseWriter, r *http.Request, apply bool) {
	b, ok := h.backend.(ComposerBackend)
	if !ok {
		writeError(w, 503, "composer merging unavailable")
		return
	}
	var input app.ComposerMerge
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	var result app.ComposerPreview
	var err error
	if apply {
		result, err = b.MergeComposers(r.Context(), currentUser(r).ID, input)
	} else {
		result, err = b.PreviewComposerMerge(r.Context(), currentUser(r).ID, input)
	}
	if err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
