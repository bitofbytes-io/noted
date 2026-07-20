package httptransport

import (
	"net/http"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/go-chi/chi/v5"
)

func (h *Handler) listMediaLinks(w http.ResponseWriter, r *http.Request) {
	items, err := h.Service.ListMediaLinks(r.Context(), currentUser(r).ID, chi.URLParam(r, "editionId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) createMediaLink(w http.ResponseWriter, r *http.Request) {
	var input app.MediaLinkInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	item, err := h.Service.CreateMediaLink(r.Context(), currentUser(r).ID, chi.URLParam(r, "editionId"), input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusCreated, item)
}

func (h *Handler) deleteMediaLink(w http.ResponseWriter, r *http.Request) {
	if err := h.Service.DeleteMediaLink(r.Context(), currentUser(r).ID, chi.URLParam(r, "mediaLinkId")); err != nil {
		h.handleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type anchorsRequest struct {
	Anchors []app.AnchorInput `json:"anchors"`
}

func (h *Handler) listMediaLinkAnchors(w http.ResponseWriter, r *http.Request) {
	items, err := h.Service.ListMediaLinkAnchors(r.Context(), currentUser(r).ID, chi.URLParam(r, "mediaLinkId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
func (h *Handler) replaceMediaLinkAnchors(w http.ResponseWriter, r *http.Request) {
	var input anchorsRequest
	if !h.decodeJSON(w, r, &input) {
		return
	}
	items, err := h.Service.ReplaceMediaLinkAnchors(r.Context(), currentUser(r).ID, chi.URLParam(r, "mediaLinkId"), input.Anchors)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
func (h *Handler) listAssetAnchors(w http.ResponseWriter, r *http.Request) {
	items, err := h.Service.ListAssetAnchors(r.Context(), currentUser(r).ID, chi.URLParam(r, "assetId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
func (h *Handler) replaceAssetAnchors(w http.ResponseWriter, r *http.Request) {
	var input anchorsRequest
	if !h.decodeJSON(w, r, &input) {
		return
	}
	items, err := h.Service.ReplaceAssetAnchors(r.Context(), currentUser(r).ID, chi.URLParam(r, "assetId"), input.Anchors)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
func (h *Handler) getMeasureMap(w http.ResponseWriter, r *http.Request) {
	item, err := h.Service.GetMeasureMap(r.Context(), currentUser(r).ID, chi.URLParam(r, "assetId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, item)
}
