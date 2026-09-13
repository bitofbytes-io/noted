package httpapi

import (
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type ImportBackend interface {
	ListImports(context.Context, string) ([]app.ImportDraft, error)
	CreateImport(context.Context, string, app.CreateImport) (app.ImportDraft, error)
	GetImport(context.Context, string, string) (app.ImportDraft, error)
	UpdateImport(context.Context, string, string, app.UpdateImport) (app.ImportDraft, error)
	DeleteImport(context.Context, string, string) error
	UploadImportSource(context.Context, string, string, string, int64, io.Reader) (app.ImportDraft, error)
	ImportSource(context.Context, string, string, string) (app.ImportAsset, assets.ReadSeekCloser, error)
	FinalizeImport(context.Context, string, string, int64, io.Reader) (app.Piece, error)
}

func (h *Handler) importBackend(w http.ResponseWriter) (ImportBackend, bool) {
	b, ok := h.backend.(ImportBackend)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "score preparation is unavailable")
	}
	return b, ok
}
func importID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "draftID")
	if _, err := uuid.Parse(id); err != nil {
		writeError(w, 400, "invalid draft id")
		return "", false
	}
	return id, true
}
func (h *Handler) listImports(w http.ResponseWriter, r *http.Request) {
	b, ok := h.importBackend(w)
	if !ok {
		return
	}
	d, err := b.ListImports(r.Context(), currentUser(r).ID)
	if err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, 200, d)
}
func (h *Handler) createImport(w http.ResponseWriter, r *http.Request) {
	b, ok := h.importBackend(w)
	if !ok {
		return
	}
	var input app.CreateImport
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	d, err := b.CreateImport(r.Context(), currentUser(r).ID, input)
	if err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, 201, d)
}
func (h *Handler) getImport(w http.ResponseWriter, r *http.Request) {
	b, ok := h.importBackend(w)
	if !ok {
		return
	}
	id, ok := importID(w, r)
	if !ok {
		return
	}
	d, err := b.GetImport(r.Context(), currentUser(r).ID, id)
	if err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, 200, d)
}
func (h *Handler) updateImport(w http.ResponseWriter, r *http.Request) {
	b, ok := h.importBackend(w)
	if !ok {
		return
	}
	id, ok := importID(w, r)
	if !ok {
		return
	}
	var input app.UpdateImport
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	d, err := b.UpdateImport(r.Context(), currentUser(r).ID, id, input)
	if err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, 200, d)
}
func (h *Handler) deleteImport(w http.ResponseWriter, r *http.Request) {
	b, ok := h.importBackend(w)
	if !ok {
		return
	}
	id, ok := importID(w, r)
	if !ok {
		return
	}
	if err := b.DeleteImport(r.Context(), currentUser(r).ID, id); err != nil {
		handleError(w, err)
		return
	}
	w.WriteHeader(204)
}
func (h *Handler) importUpload(w http.ResponseWriter, r *http.Request, final bool) {
	b, ok := h.importBackend(w)
	if !ok {
		return
	}
	id, ok := importID(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, h.maxUploadBytes+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		writeError(w, 413, "file must fit the upload limit")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	revision, err := strconv.ParseInt(r.FormValue("revision"), 10, 64)
	if err != nil || revision < 0 {
		writeError(w, 400, "revision must be a nonnegative integer")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, "file must be supplied")
		return
	}
	defer file.Close()
	if header.Size > h.maxUploadBytes {
		writeError(w, 413, "file exceeds upload limit")
		return
	}
	reader := &hardLimitReader{reader: file, left: h.maxUploadBytes}
	if final {
		p, err := b.FinalizeImport(r.Context(), currentUser(r).ID, id, revision, reader)
		if err != nil {
			handleError(w, err)
			return
		}
		writeJSON(w, 200, p)
		return
	}
	filename := path.Base(strings.ReplaceAll(header.Filename, "\\", "/"))
	if len(filename) > 255 || filename == "." {
		filename = "Imported score"
	}
	d, err := b.UploadImportSource(r.Context(), currentUser(r).ID, id, filename, revision, reader)
	if err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, 201, d)
}
func (h *Handler) uploadImportSource(w http.ResponseWriter, r *http.Request) {
	h.importUpload(w, r, false)
}
func (h *Handler) finalizeImport(w http.ResponseWriter, r *http.Request) { h.importUpload(w, r, true) }
func (h *Handler) serveImportSource(w http.ResponseWriter, r *http.Request) {
	b, ok := h.importBackend(w)
	if !ok {
		return
	}
	id, ok := importID(w, r)
	if !ok {
		return
	}
	assetID := chi.URLParam(r, "assetID")
	if _, err := uuid.Parse(assetID); err != nil {
		writeError(w, 400, "invalid source id")
		return
	}
	a, reader, err := b.ImportSource(r.Context(), currentUser(r).ID, id, assetID)
	if err != nil {
		handleError(w, err)
		return
	}
	defer reader.Close()
	w.Header().Set("Content-Type", a.MIME)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": a.Filename}))
	http.ServeContent(w, r, fmt.Sprintf("source-%s", a.ID), a.CreatedAt, reader)
}
