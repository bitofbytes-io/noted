package httptransport

import (
	"context"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/go-chi/chi/v5"
)

func (h *Handler) health(w http.ResponseWriter, _ *http.Request) {
	h.writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 2*time.Second)
	defer cancel()
	if err := h.Service.Pool.Ping(ctx); err != nil {
		h.writeError(w, http.StatusServiceUnavailable, "not_ready", "database is unavailable", nil)
		return
	}
	if err := h.Service.Store.Ready(ctx); err != nil {
		h.writeError(w, http.StatusServiceUnavailable, "not_ready", "asset storage is unavailable", nil)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (h *Handler) session(w http.ResponseWriter, r *http.Request) {
	h.writeJSON(w, http.StatusOK, map[string]any{"user": currentUser(r), "authMode": h.Config.AuthMode, "development": true})
}

func parseWeek(value string) (time.Time, error) {
	if value == "" {
		return time.Now().UTC(), nil
	}
	return time.Parse("2006-01-02", value)
}

func (h *Handler) dashboard(w http.ResponseWriter, r *http.Request) {
	week, err := parseWeek(r.URL.Query().Get("week"))
	if err != nil {
		h.writeError(w, http.StatusUnprocessableEntity, "validation_failed", "week must use YYYY-MM-DD", map[string]string{"week": "invalid date"})
		return
	}
	value, err := h.Service.GetDashboard(r.Context(), currentUser(r).ID, week)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) listWorks(w http.ResponseWriter, r *http.Request) {
	filters := app.WorkFilters{Query: r.URL.Query().Get("q"), Status: r.URL.Query().Get("status"), Tag: r.URL.Query().Get("tag")}
	if raw := r.URL.Query().Get("favorite"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			h.writeError(w, http.StatusUnprocessableEntity, "validation_failed", "favorite must be true or false", map[string]string{"favorite": "invalid boolean"})
			return
		}
		filters.Favorite = &value
	}
	works, err := h.Service.ListWorks(r.Context(), currentUser(r).ID, filters)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]any{"items": works})
}

func (h *Handler) createWork(w http.ResponseWriter, r *http.Request) {
	var input app.CreateWorkInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.CreateWork(r.Context(), currentUser(r).ID, input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusCreated, value)
}

func (h *Handler) getWork(w http.ResponseWriter, r *http.Request) {
	value, err := h.Service.GetWork(r.Context(), currentUser(r).ID, chi.URLParam(r, "workId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) updateLearnerState(w http.ResponseWriter, r *http.Request) {
	var input app.LearnerStateInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.UpdateLearnerState(r.Context(), currentUser(r).ID, chi.URLParam(r, "workId"), input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) addMovement(w http.ResponseWriter, r *http.Request) {
	var input app.MovementInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.AddMovement(r.Context(), currentUser(r).ID, chi.URLParam(r, "workId"), input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusCreated, value)
}

func (h *Handler) addEdition(w http.ResponseWriter, r *http.Request) {
	var input app.EditionInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.AddEdition(r.Context(), currentUser(r).ID, chi.URLParam(r, "workId"), input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusCreated, value)
}

func (h *Handler) listTags(w http.ResponseWriter, r *http.Request) {
	items, err := h.Service.ListTags(r.Context(), currentUser(r).ID)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) createTag(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name string `json:"name"`
	}
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.CreateTag(r.Context(), currentUser(r).ID, input.Name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusCreated, value)
}

func (h *Handler) replaceWorkTags(w http.ResponseWriter, r *http.Request) {
	var input struct {
		TagIDs []string `json:"tagIds"`
	}
	if !h.decodeJSON(w, r, &input) {
		return
	}
	items, err := h.Service.ReplaceWorkTags(r.Context(), currentUser(r).ID, chi.URLParam(r, "workId"), input.TagIDs)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) uploadAsset(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, h.Config.MaxUploadBytes+(1<<20))
	if err := r.ParseMultipartForm(h.Config.MaxUploadBytes + (1 << 20)); err != nil {
		h.writeError(w, http.StatusRequestEntityTooLarge, "upload_too_large", "upload exceeds the configured limit", nil)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		h.writeError(w, http.StatusUnprocessableEntity, "validation_failed", "a file is required", map[string]string{"file": "is required"})
		return
	}
	defer file.Close()
	if header.Size <= 0 || header.Size > h.Config.MaxUploadBytes {
		h.writeError(w, http.StatusRequestEntityTooLarge, "upload_too_large", "upload exceeds the configured limit", nil)
		return
	}
	value, err := h.Service.UploadAsset(r.Context(), currentUser(r).ID, chi.URLParam(r, "editionId"), header, file, app.UploadMetadata{SourceURL: r.FormValue("sourceUrl"), RightsNote: r.FormValue("rightsNote")})
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusCreated, value)
}

func (h *Handler) getAsset(w http.ResponseWriter, r *http.Request) {
	value, err := h.Service.GetAsset(r.Context(), currentUser(r).ID, chi.URLParam(r, "assetId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) assetContent(w http.ResponseWriter, r *http.Request) {
	item, file, err := h.Service.OpenAsset(r.Context(), currentUser(r).ID, chi.URLParam(r, "assetId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", item.MediaType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": safeFilename(item.OriginalFilename)}))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, item.OriginalFilename, item.CreatedAt, file)
}

func safeFilename(value string) string {
	value = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || r == '/' || r == '\\' {
			return '_'
		}
		return r
	}, value)
	if value == "" {
		return "score"
	}
	return value
}

func (h *Handler) deleteAsset(w http.ResponseWriter, r *http.Request) {
	if err := h.Service.DeleteAsset(r.Context(), currentUser(r).ID, chi.URLParam(r, "assetId")); err != nil {
		h.handleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) listPractice(w http.ResponseWriter, r *http.Request) {
	items, err := h.Service.ListPractice(r.Context(), currentUser(r).ID, r.URL.Query().Get("workId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) startPractice(w http.ResponseWriter, r *http.Request) {
	var input app.PracticeInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.StartPractice(r.Context(), currentUser(r).ID, input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusCreated, value)
}

func (h *Handler) stopPractice(w http.ResponseWriter, r *http.Request) {
	var input app.StopPracticeInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.StopPractice(r.Context(), currentUser(r).ID, chi.URLParam(r, "sessionId"), input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) createManualPractice(w http.ResponseWriter, r *http.Request) {
	var input app.PracticeInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.CreateManualPractice(r.Context(), currentUser(r).ID, input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusCreated, value)
}

func (h *Handler) updatePractice(w http.ResponseWriter, r *http.Request) {
	var input app.PracticePatchInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.UpdatePractice(r.Context(), currentUser(r).ID, chi.URLParam(r, "sessionId"), input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) deletePractice(w http.ResponseWriter, r *http.Request) {
	if err := h.Service.DeletePractice(r.Context(), currentUser(r).ID, chi.URLParam(r, "sessionId")); err != nil {
		h.handleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) practiceSummary(w http.ResponseWriter, r *http.Request) {
	week, err := parseWeek(r.URL.Query().Get("week"))
	if err != nil {
		h.writeError(w, http.StatusUnprocessableEntity, "validation_failed", "week must use YYYY-MM-DD", map[string]string{"week": "invalid date"})
		return
	}
	value, err := h.Service.PracticeWeek(r.Context(), currentUser(r).ID, week)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) getPreferences(w http.ResponseWriter, r *http.Request) {
	value, err := h.Service.GetPreferences(r.Context(), currentUser(r).ID)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) updatePreferences(w http.ResponseWriter, r *http.Request) {
	var input app.Preferences
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.UpdatePreferences(r.Context(), currentUser(r).ID, input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func contextWithTimeout(r *http.Request, duration time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), duration)
}
