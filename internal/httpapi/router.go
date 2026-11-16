package httpapi

import (
	"context"
	"net/http"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/bitofbytes-io/noted/internal/metrics"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type Backend interface {
	ListPieces(context.Context, string, app.ListOptions) ([]app.Piece, error)
	ListPieceSummaries(context.Context, string, app.ListOptions) ([]app.PieceSummary, error)
	ContinuePiece(context.Context, string) (*app.Piece, error)
	GetPiece(context.Context, string, string) (app.Piece, error)
	CreatePiece(context.Context, string, app.PieceInput) (app.Piece, error)
	UpdatePiece(context.Context, string, string, app.PiecePatch) (app.Piece, error)
	DeletePiece(context.Context, string, string) error
	PDFSource(context.Context, string, string) (app.PDFSource, assets.ReadSeekCloser, error)
	GetReaderState(context.Context, string, string) (app.ReaderState, error)
	PutReaderState(context.Context, string, string, app.ReaderState) (app.ReaderState, error)
}

type Handler struct {
	backend        Backend
	auth           Authenticator
	config         config.Config
	maxUploadBytes int64
	allowedOrigin  string
	metrics        *metrics.Metrics
	// Google's OAuth token and userinfo endpoints; tests point them at a fake.
	googleTokenURL    string
	googleUserInfoURL string
}

// NewRouter builds the public API. A nil m records no metrics. /metrics is never
// served here, only on the internal metrics listener.
func NewRouter(
	backend Backend, authenticator Authenticator, cfg config.Config, m *metrics.Metrics,
) http.Handler {
	handler := &Handler{
		backend: backend, auth: authenticator, config: cfg,
		maxUploadBytes: cfg.MaxUploadBytes, allowedOrigin: cfg.AllowedOrigin, metrics: m,
		googleTokenURL: googleTokenEndpoint, googleUserInfoURL: googleUserInfoEndpoint,
	}
	return newRouter(handler)
}

func newRouter(handler *Handler) http.Handler {
	m := handler.metrics
	router := chi.NewRouter()
	router.Use(m.Middleware("/api/health", "/api/ready"))
	router.Use(middleware.RequestID, trustedProxyIP(handler.config.TrustedProxyCIDRs), middleware.Recoverer)
	router.Use(handler.cors)
	health := func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
	}
	// Health means the process is up; ready means its database and asset store answer too.
	router.Get("/api/health", health)
	router.Get("/api/ready", handler.ready)
	router.Get("/api/auth/google", handler.startGoogleLogin)
	router.Get("/api/auth/google/callback", handler.googleCallback)
	router.Get("/api/session", handler.session)
	router.Delete("/api/session", handler.logout)
	// Send to Noted: the only route a shortcut token opens, and it opens no other.
	router.With(handler.shortcutUser, m.CountUploads(metrics.UploadShortcut)).
		Post("/api/shortcut/import", handler.shortcutImport)
	router.Group(func(router chi.Router) {
		router.Use(handler.authenticatedUser)
		router.Get("/api/composers/", handler.listComposers)
		router.Post("/api/composers/preview", handler.previewComposerMerge)
		router.Patch("/api/composers/", handler.mergeComposers)
		router.Get("/api/library/export", handler.exportLibrary)
		router.Get("/api/library/suggestions", handler.suggestPieces)
		router.Get("/api/account/shortcut-token", handler.shortcutTokenStatus)
		router.Post("/api/account/shortcut-token", handler.createShortcutToken)
		router.Delete("/api/account/shortcut-token", handler.deleteShortcutToken)
		router.Get("/api/account/preferences", handler.getPreferences)
		router.Put("/api/account/preferences", handler.putPreferences)
		router.Get("/api/imslp/works", handler.searchIMSLPWorks)
		router.Route("/api/imports", func(router chi.Router) {
			router.Get("/", handler.listImports)
			router.Post("/", handler.createImport)
			router.Route("/{draftID}", func(router chi.Router) {
				router.Get("/", handler.getImport)
				router.Patch("/", handler.updateImport)
				router.Delete("/", handler.deleteImport)
				router.With(m.CountUploads(metrics.UploadSource)).Post("/sources", handler.uploadImportSource)
				router.Get("/sources/{assetID}", handler.serveImportSource)
				router.Head("/sources/{assetID}", handler.serveImportSource)
				router.With(m.CountUploads(metrics.UploadFinalize)).Post("/finalize", handler.finalizeImport)
			})
		})
		router.Route("/api/pieces", func(router chi.Router) {
			router.Get("/", handler.listPieces)
			router.Post("/", handler.createPiece)
			router.Get("/continue", handler.continuePiece)
			router.Route("/{pieceID}", func(router chi.Router) {
				router.Get("/", handler.getPiece)
				router.Patch("/", handler.updatePiece)
				router.Delete("/", handler.deletePiece)
				router.Get("/pdf", handler.servePDF)
				router.Head("/pdf", handler.servePDF)
				router.Get("/pdf/download", handler.downloadPDF)
				router.Head("/pdf/download", handler.downloadPDF)
				router.Get("/reader-state", handler.getReaderState)
				router.Put("/reader-state", handler.putReaderState)
			})
		})
	})
	return router
}

func (h *Handler) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		origin := request.Header.Get("Origin")
		if origin != "" {
			writer.Header().Add("Vary", "Origin")
			if origin == h.allowedOrigin {
				writer.Header().Set("Access-Control-Allow-Origin", origin)
				writer.Header().Set("Access-Control-Allow-Credentials", "true")
				writer.Header().Set("Access-Control-Allow-Headers", "Content-Type")
				writer.Header().Set("Access-Control-Allow-Methods", "GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS")
			} else if isStateChangingMethod(request.Method) {
				writeError(writer, http.StatusForbidden, "request origin is not allowed")
				return
			}
		}
		if request.Method == http.MethodOptions {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func isStateChangingMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodTrace:
		return false
	default:
		return true
	}
}
