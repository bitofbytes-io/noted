package httptransport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
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

func (h *Handler) updateWork(w http.ResponseWriter, r *http.Request) {
	var input app.WorkPatchInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.UpdateWork(r.Context(), currentUser(r).ID, chi.URLParam(r, "workId"), input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) deleteWork(w http.ResponseWriter, r *http.Request) {
	if err := h.Service.DeleteWork(r.Context(), currentUser(r).ID, chi.URLParam(r, "workId")); err != nil {
		h.handleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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

func (h *Handler) updateEdition(w http.ResponseWriter, r *http.Request) {
	var input app.EditionInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.UpdateEdition(r.Context(), currentUser(r).ID, chi.URLParam(r, "editionId"), input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) deleteEdition(w http.ResponseWriter, r *http.Request) {
	if err := h.Service.DeleteEdition(r.Context(), currentUser(r).ID, chi.URLParam(r, "editionId")); err != nil {
		h.handleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
	header, file, metadata, err := h.readMultipartUpload(r)
	if err != nil {
		h.handleUploadReadError(w, err)
		return
	}
	defer file.Close()
	value, err := h.Service.UploadAsset(r.Context(), currentUser(r).ID, chi.URLParam(r, "editionId"), header, file, metadata)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusCreated, value)
}

func (h *Handler) handleUploadReadError(w http.ResponseWriter, err error) {
	var maxBytesError *http.MaxBytesError
	if errors.Is(err, errUploadTooLarge) || errors.As(err, &maxBytesError) {
		h.writeError(w, http.StatusRequestEntityTooLarge, "upload_too_large", "upload exceeds the configured limit", nil)
		return
	}
	h.writeError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error(), map[string]string{"file": "is required"})
}

var errUploadTooLarge = errors.New("upload exceeds the configured limit")

func (h *Handler) readMultipartUpload(r *http.Request) (*multipart.FileHeader, multipart.File, app.UploadMetadata, error) {
	reader, err := r.MultipartReader()
	if err != nil {
		return nil, nil, app.UploadMetadata{}, fmt.Errorf("request must use multipart form data: %w", err)
	}

	var (
		header   *multipart.FileHeader
		file     *os.File
		metadata app.UploadMetadata
	)
	cleanup := func() {
		if file != nil {
			name := file.Name()
			_ = file.Close()
			_ = os.Remove(name)
		}
	}
	fail := func(err error) (*multipart.FileHeader, multipart.File, app.UploadMetadata, error) {
		cleanup()
		return nil, nil, app.UploadMetadata{}, err
	}

	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return fail(nextErr)
		}
		name := part.FormName()
		switch name {
		case "file":
			filename := part.FileName()
			if file != nil || filename == "" {
				_ = part.Close()
				return fail(errors.New("exactly one file is required"))
			}
			file, err = os.CreateTemp("", "noted-upload-*")
			if err != nil {
				_ = part.Close()
				return fail(fmt.Errorf("create upload staging file: %w", err))
			}
			size, copyErr := io.Copy(file, io.LimitReader(part, h.Config.MaxUploadBytes+1))
			_ = part.Close()
			if copyErr != nil {
				return fail(fmt.Errorf("stream upload: %w", copyErr))
			}
			if size <= 0 {
				return fail(errors.New("file must not be empty"))
			}
			if size > h.Config.MaxUploadBytes {
				return fail(errUploadTooLarge)
			}
			if _, err = file.Seek(0, io.SeekStart); err != nil {
				return fail(fmt.Errorf("rewind upload: %w", err))
			}
			header = &multipart.FileHeader{Filename: filename, Size: size}
		case "sourceUrl", "rightsNote":
			value, readErr := io.ReadAll(io.LimitReader(part, 64<<10))
			_ = part.Close()
			if readErr != nil {
				return fail(fmt.Errorf("read %s: %w", name, readErr))
			}
			if name == "sourceUrl" {
				metadata.SourceURL = string(value)
			} else {
				metadata.RightsNote = string(value)
			}
		default:
			_ = part.Close()
		}
	}
	if file == nil || header == nil {
		return fail(errors.New("a file is required"))
	}

	stagedName := file.Name()
	return header, &stagedUpload{File: file, path: stagedName}, metadata, nil
}

type stagedUpload struct {
	*os.File
	path string
}

func (f *stagedUpload) Close() error {
	err := f.File.Close()
	if removeErr := os.Remove(f.path); err == nil {
		err = removeErr
	}
	return err
}

func (h *Handler) getAsset(w http.ResponseWriter, r *http.Request) {
	value, err := h.Service.GetAsset(r.Context(), currentUser(r).ID, chi.URLParam(r, "assetId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) updateAsset(w http.ResponseWriter, r *http.Request) {
	var input app.AssetPatchInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	value, err := h.Service.UpdateAsset(r.Context(), currentUser(r).ID, chi.URLParam(r, "assetId"), input)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) replaceAsset(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, h.Config.MaxUploadBytes+(1<<20))
	header, file, metadata, err := h.readMultipartUpload(r)
	if err != nil {
		h.handleUploadReadError(w, err)
		return
	}
	defer file.Close()
	assetID := chi.URLParam(r, "assetId")
	old, err := h.Service.GetAsset(r.Context(), currentUser(r).ID, assetID)
	if err != nil {
		h.handleError(w, err)
		return
	}
	metadata = replacementMetadata(old, metadata)
	value, err := h.Service.UploadAsset(r.Context(), currentUser(r).ID, old.EditionID, header, file, metadata)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusCreated, value)
}

func replacementMetadata(old app.Asset, metadata app.UploadMetadata) app.UploadMetadata {
	metadata.ReplacesAssetID = old.ID
	if old.AssetType == "musicxml" && (old.DerivedFromAssetID != nil || old.VerificationState == "unverified_ocr") {
		metadata.VerificationState = "corrected"
		if old.DerivedFromAssetID != nil {
			metadata.DerivedFromAssetID = *old.DerivedFromAssetID
		}
	}
	return metadata
}

func (h *Handler) assetContent(w http.ResponseWriter, r *http.Request) {
	h.serveAsset(w, r, "inline")
}

func (h *Handler) assetDownload(w http.ResponseWriter, r *http.Request) {
	h.serveAsset(w, r, "attachment")
}

func (h *Handler) serveAsset(w http.ResponseWriter, r *http.Request, disposition string) {
	item, file, err := h.Service.OpenAsset(r.Context(), currentUser(r).ID, chi.URLParam(r, "assetId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", item.MediaType)
	filename := item.OriginalFilename
	if disposition == "attachment" {
		filename = downloadFilename(item.DisplayName, item.OriginalFilename)
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": safeFilename(filename)}))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, filename, item.CreatedAt, file)
}

func downloadFilename(displayName, originalFilename string) string {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		displayName = originalFilename
	}
	originalExtension := filepath.Ext(originalFilename)
	if originalExtension != "" && !strings.EqualFold(filepath.Ext(displayName), originalExtension) {
		displayName += originalExtension
	}
	return displayName
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

func (h *Handler) createRecognitionJob(w http.ResponseWriter, r *http.Request) {
	value, err := h.Service.CreateRecognitionJob(r.Context(), currentUser(r).ID, chi.URLParam(r, "assetId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusAccepted, value)
}

func (h *Handler) listRecognitionJobs(w http.ResponseWriter, r *http.Request) {
	items, err := h.Service.ListRecognitionJobs(r.Context(), currentUser(r).ID, chi.URLParam(r, "assetId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) getRecognitionJob(w http.ResponseWriter, r *http.Request) {
	value, err := h.Service.GetRecognitionJob(r.Context(), currentUser(r).ID, chi.URLParam(r, "jobId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, value)
}

func (h *Handler) retryRecognitionJob(w http.ResponseWriter, r *http.Request) {
	value, err := h.Service.RetryRecognitionJob(r.Context(), currentUser(r).ID, chi.URLParam(r, "jobId"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusAccepted, value)
}

func (h *Handler) cancelRecognitionJob(w http.ResponseWriter, r *http.Request) {
	if err := h.Service.CancelRecognitionJob(r.Context(), currentUser(r).ID, chi.URLParam(r, "jobId")); err != nil {
		h.handleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) listPractice(w http.ResponseWriter, r *http.Request) {
	filters, err := parsePracticeFilters(r)
	if err != nil {
		h.handleError(w, err)
		return
	}
	items, err := h.Service.ListPractice(r.Context(), currentUser(r).ID, filters)
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func parsePracticeFilters(r *http.Request) (app.PracticeFilters, error) {
	filters := app.PracticeFilters{WorkID: r.URL.Query().Get("workId")}
	fields := map[string]string{}
	for name, target := range map[string]**time.Time{"from": &filters.From, "to": &filters.To} {
		raw := r.URL.Query().Get(name)
		if raw == "" {
			continue
		}
		value, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			fields[name] = "must be an RFC 3339 timestamp"
			continue
		}
		*target = &value
	}
	if len(fields) == 0 && filters.From != nil && filters.To != nil && filters.From.After(*filters.To) {
		fields["from"] = "must not follow to"
	}
	if len(fields) > 0 {
		return app.PracticeFilters{}, app.ValidationError{Fields: fields}
	}
	return filters, nil
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
