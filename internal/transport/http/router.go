package httptransport

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	assetstore "github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type userContextKey struct{}

type Handler struct {
	Service *app.Service
	Auth    *auth.Service
	Config  config.Config
	Logger  *slog.Logger
}

func NewRouter(service *app.Service, authService *auth.Service, cfg config.Config, logger *slog.Logger) http.Handler {
	h := &Handler{Service: service, Auth: authService, Config: cfg, Logger: logger}
	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.RealIP, middleware.Recoverer, h.requestLog, h.cors)
	r.Get("/api/health", h.health)
	r.Get("/api/ready", h.ready)
	r.Get("/api/auth/google", h.startGoogleLogin)
	r.Get("/api/auth/google/callback", h.googleCallback)
	r.Get("/api/session", h.session)
	r.Delete("/api/session", h.logout)
	r.Group(func(r chi.Router) {
		r.Use(h.authenticatedUser)
		r.Get("/api/dashboard", h.dashboard)
		r.Get("/api/works", h.listWorks)
		r.Post("/api/works", h.createWork)
		r.Get("/api/works/{workId}", h.getWork)
		r.Patch("/api/works/{workId}", h.updateWork)
		r.Delete("/api/works/{workId}", h.deleteWork)
		r.Put("/api/works/{workId}/learner-state", h.updateLearnerState)
		r.Post("/api/works/{workId}/movements", h.addMovement)
		r.Post("/api/works/{workId}/editions", h.addEdition)
		r.Patch("/api/editions/{editionId}", h.updateEdition)
		r.Delete("/api/editions/{editionId}", h.deleteEdition)
		r.Get("/api/tags", h.listTags)
		r.Post("/api/tags", h.createTag)
		r.Put("/api/works/{workId}/tags", h.replaceWorkTags)
		r.Post("/api/editions/{editionId}/assets", h.uploadAsset)
		r.Get("/api/editions/{editionId}/media-links", h.listMediaLinks)
		r.Post("/api/editions/{editionId}/media-links", h.createMediaLink)
		r.Delete("/api/media-links/{mediaLinkId}", h.deleteMediaLink)
		r.Get("/api/media-links/{mediaLinkId}/anchors", h.listMediaLinkAnchors)
		r.Put("/api/media-links/{mediaLinkId}/anchors", h.replaceMediaLinkAnchors)
		r.Get("/api/assets/{assetId}", h.getAsset)
		r.Get("/api/assets/{assetId}/anchors", h.listAssetAnchors)
		r.Put("/api/assets/{assetId}/anchors", h.replaceAssetAnchors)
		r.Get("/api/assets/{assetId}/measure-map", h.getMeasureMap)
		r.Patch("/api/assets/{assetId}", h.updateAsset)
		r.Post("/api/assets/{assetId}/replacement", h.replaceAsset)
		r.Get("/api/assets/{assetId}/content", h.assetContent)
		r.Get("/api/assets/{assetId}/download", h.assetDownload)
		r.Delete("/api/assets/{assetId}", h.deleteAsset)
		r.Post("/api/assets/{assetId}/recognition-jobs", h.createRecognitionJob)
		r.Get("/api/assets/{assetId}/recognition-jobs", h.listRecognitionJobs)
		r.Get("/api/recognition-jobs/{jobId}", h.getRecognitionJob)
		r.Get("/api/recognition-jobs/{jobId}/project", h.downloadRecognitionProject)
		r.Post("/api/recognition-jobs/{jobId}/retry", h.retryRecognitionJob)
		r.Delete("/api/recognition-jobs/{jobId}", h.cancelRecognitionJob)
		r.Get("/api/practice-sessions", h.listPractice)
		r.Post("/api/practice-sessions/start", h.startPractice)
		r.Post("/api/practice-sessions/{sessionId}/stop", h.stopPractice)
		r.Post("/api/practice-sessions", h.createManualPractice)
		r.Patch("/api/practice-sessions/{sessionId}", h.updatePractice)
		r.Delete("/api/practice-sessions/{sessionId}", h.deletePractice)
		r.Get("/api/practice-summary", h.practiceSummary)
		r.Get("/api/preferences", h.getPreferences)
		r.Patch("/api/preferences", h.updatePreferences)
	})
	return r
}

func (h *Handler) requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		h.Logger.Debug("request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(start), "request_id", middleware.GetReqID(r.Context()))
	})
}

func (h *Handler) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		for _, allowed := range h.Config.AllowedOrigins {
			if origin == allowed {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
				w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
				break
			}
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *Handler) authenticatedUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var user app.User
		var err error
		switch h.Config.AuthMode {
		case "development":
			user, err = h.Service.CurrentUser(r.Context(), h.Config.DevUserEmail)
		case "google":
			cookie, cookieErr := r.Cookie(auth.SessionCookieName)
			if cookieErr != nil {
				h.writeError(w, http.StatusUnauthorized, "not_authenticated", "sign in to continue", nil)
				return
			}
			user, err = h.Auth.ResolveSession(r.Context(), cookie.Value)
		default:
			err = auth.ErrNotAuthenticated
		}
		if errors.Is(err, auth.ErrNotAuthenticated) || errors.Is(err, app.ErrNotFound) {
			if h.Config.AuthMode == "google" {
				h.clearSessionCookie(w)
			}
			h.writeError(w, http.StatusUnauthorized, "not_authenticated", "sign in to continue", nil)
			return
		}
		if err != nil {
			h.handleError(w, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userContextKey{}, user)))
	})
}

func currentUser(r *http.Request) app.User {
	return r.Context().Value(userContextKey{}).(app.User)
}

func (h *Handler) decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		h.writeError(w, http.StatusBadRequest, "validation_failed", "request body is not valid JSON", map[string]string{"body": err.Error()})
		return false
	}
	return true
}

func (h *Handler) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		h.Logger.Error("encode response", "error", err)
	}
}

func (h *Handler) writeError(w http.ResponseWriter, status int, code, message string, fields map[string]string) {
	h.writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message, "fields": fields}})
}

func (h *Handler) handleError(w http.ResponseWriter, err error) {
	var validation app.ValidationError
	switch {
	case errors.As(err, &validation):
		h.writeError(w, http.StatusUnprocessableEntity, "validation_failed", "correct the highlighted fields", validation.Fields)
	case errors.Is(err, app.ErrNotFound):
		h.writeError(w, http.StatusNotFound, "not_found", "the requested resource was not found", nil)
	case errors.Is(err, app.ErrNotAuthorized):
		h.writeError(w, http.StatusForbidden, "not_authorized", "the resource belongs to another learner", nil)
	case errors.Is(err, app.ErrAssetInUse):
		h.writeError(w, http.StatusConflict, "asset_in_use", "this score is used by practice history; archive it instead", nil)
	case errors.Is(err, app.ErrEditionInUse):
		h.writeError(w, http.StatusConflict, "edition_in_use", "this edition contains a score used by practice history; archive it instead", nil)
	case errors.Is(err, app.ErrWorkInUse):
		h.writeError(w, http.StatusConflict, "work_in_use", "this work has practice history; archive it instead", nil)
	case errors.Is(err, app.ErrRecognitionUnavailable):
		h.writeError(w, http.StatusServiceUnavailable, "recognition_unavailable", "PDF conversion is not configured", nil)
	case errors.Is(err, app.ErrConflict):
		h.writeError(w, http.StatusConflict, "practice_timer_already_running", "stop the running practice timer first", nil)
	case errors.Is(err, assetstore.ErrUnsupportedUpload):
		h.writeError(w, http.StatusUnsupportedMediaType, "unsupported_asset_type", err.Error(), nil)
	default:
		h.Logger.Error("request failed", "error", err)
		h.writeError(w, http.StatusInternalServerError, "internal_error", "the request could not be completed", nil)
	}
}
