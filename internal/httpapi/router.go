package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"unicode"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
)

type Backend interface {
	ListPieces(context.Context, string, string, *bool) ([]app.Piece, error)
	GetPiece(context.Context, string, string) (app.Piece, error)
	CreatePiece(context.Context, string, app.PieceInput) (app.Piece, error)
	UpdatePiece(context.Context, string, string, app.PiecePatch) (app.Piece, error)
	DeletePiece(context.Context, string, string) error
	UploadPDF(context.Context, string, string, string, int, io.Reader) (app.Piece, error)
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
}

func NewRouter(backend Backend, authenticator Authenticator, cfg config.Config) http.Handler {
	handler := &Handler{
		backend: backend, auth: authenticator, config: cfg,
		maxUploadBytes: cfg.MaxUploadBytes, allowedOrigin: cfg.AllowedOrigin,
	}
	router := chi.NewRouter()
	router.Use(middleware.RequestID, middleware.RealIP, middleware.Recoverer)
	router.Use(handler.cors)
	health := func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
	}
	router.Get("/api/health", health)
	router.Get("/api/ready", health)
	router.Get("/api/auth/google", handler.startGoogleLogin)
	router.Get("/api/auth/google/callback", handler.googleCallback)
	router.Get("/api/session", handler.session)
	router.Delete("/api/session", handler.logout)
	router.Group(func(router chi.Router) {
		router.Use(handler.authenticatedUser)
		router.Route("/api/imports", func(router chi.Router) {
			router.Get("/", handler.listImports)
			router.Post("/", handler.createImport)
			router.Route("/{draftID}", func(router chi.Router) {
				router.Get("/", handler.getImport)
				router.Patch("/", handler.updateImport)
				router.Delete("/", handler.deleteImport)
				router.Post("/sources", handler.uploadImportSource)
				router.Get("/sources/{assetID}", handler.serveImportSource)
				router.Head("/sources/{assetID}", handler.serveImportSource)
				router.Post("/finalize", handler.finalizeImport)
			})
		})
		router.Route("/api/pieces", func(router chi.Router) {
			router.Get("/", handler.listPieces)
			router.Post("/", handler.createPiece)
			router.Route("/{pieceID}", func(router chi.Router) {
				router.Get("/", handler.getPiece)
				router.Patch("/", handler.updatePiece)
				router.Delete("/", handler.deletePiece)
				router.Post("/pdf", handler.uploadPDF)
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

func (h *Handler) listPieces(writer http.ResponseWriter, request *http.Request) {
	var favorite *bool
	if value := request.URL.Query().Get("favorite"); value != "" {
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			writeError(writer, http.StatusBadRequest, "favorite must be true or false")
			return
		}
		favorite = &parsed
	}
	pieces, err := h.backend.ListPieces(
		request.Context(), currentUser(request).ID, request.URL.Query().Get("q"), favorite,
	)
	if err != nil {
		handleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, pieces)
}

func (h *Handler) getPiece(writer http.ResponseWriter, request *http.Request) {
	id, ok := pieceID(writer, request)
	if !ok {
		return
	}
	piece, err := h.backend.GetPiece(request.Context(), currentUser(request).ID, id)
	if err != nil {
		handleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, piece)
}

func (h *Handler) createPiece(writer http.ResponseWriter, request *http.Request) {
	var input app.PieceInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	piece, err := h.backend.CreatePiece(request.Context(), currentUser(request).ID, input)
	if err != nil {
		handleError(writer, err)
		return
	}
	writer.Header().Set("Location", "/api/pieces/"+piece.ID)
	writeJSON(writer, http.StatusCreated, piece)
}

func (h *Handler) updatePiece(writer http.ResponseWriter, request *http.Request) {
	id, ok := pieceID(writer, request)
	if !ok {
		return
	}
	var patch app.PiecePatch
	if err := decodeJSON(request, &patch); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	piece, err := h.backend.UpdatePiece(request.Context(), currentUser(request).ID, id, patch)
	if err != nil {
		handleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, piece)
}

func (h *Handler) deletePiece(writer http.ResponseWriter, request *http.Request) {
	id, ok := pieceID(writer, request)
	if !ok {
		return
	}
	if err := h.backend.DeletePiece(request.Context(), currentUser(request).ID, id); err != nil {
		handleError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (h *Handler) uploadPDF(writer http.ResponseWriter, request *http.Request) {
	id, ok := pieceID(writer, request)
	if !ok {
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, h.maxUploadBytes+(1<<20))
	if err := request.ParseMultipartForm(1 << 20); err != nil {
		writeError(writer, http.StatusBadRequest, "upload is too large or malformed")
		return
	}
	file, header, err := request.FormFile("file")
	if err != nil {
		writeError(writer, http.StatusBadRequest, "a PDF file is required")
		return
	}
	defer file.Close()
	if request.MultipartForm != nil {
		defer request.MultipartForm.RemoveAll()
	}
	pageCount, err := strconv.Atoi(request.FormValue("pageCount"))
	if err != nil || pageCount < 1 || pageCount > 10000 {
		writeError(writer, http.StatusBadRequest, "pageCount must be between 1 and 10000")
		return
	}
	signature := make([]byte, 5)
	if _, err := io.ReadFull(file, signature); err != nil || string(signature) != "%PDF-" {
		writeError(writer, http.StatusBadRequest, "the selected file is not a valid PDF")
		return
	}
	filename := safeFilename(header.Filename)
	limited := &hardLimitReader{
		reader: io.MultiReader(strings.NewReader(string(signature)), file),
		left:   h.maxUploadBytes,
	}
	piece, err := h.backend.UploadPDF(
		request.Context(), currentUser(request).ID, id, filename, pageCount, limited,
	)
	if err != nil {
		if errors.Is(err, errUploadTooLarge) {
			writeError(writer, http.StatusRequestEntityTooLarge, "PDF exceeds the upload limit")
			return
		}
		handleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, piece)
}

func (h *Handler) servePDF(writer http.ResponseWriter, request *http.Request) {
	h.servePDFContent(writer, request, "inline")
}

func (h *Handler) downloadPDF(writer http.ResponseWriter, request *http.Request) {
	h.servePDFContent(writer, request, "attachment")
}

func (h *Handler) servePDFContent(
	writer http.ResponseWriter,
	request *http.Request,
	dispositionType string,
) {
	id, ok := pieceID(writer, request)
	if !ok {
		return
	}
	source, reader, err := h.backend.PDFSource(request.Context(), currentUser(request).ID, id)
	if err != nil {
		handleError(writer, err)
		return
	}
	defer reader.Close()
	filename := safeFilename(source.OriginalFilename)
	disposition := mime.FormatMediaType(dispositionType, map[string]string{"filename": filename})
	writer.Header().Set("Content-Type", "application/pdf")
	writer.Header().Set("Content-Disposition", disposition)
	writer.Header().Set("Accept-Ranges", "bytes")
	writer.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	http.ServeContent(writer, request, filename, source.UploadedAt, reader)
}

func (h *Handler) getReaderState(writer http.ResponseWriter, request *http.Request) {
	id, ok := pieceID(writer, request)
	if !ok {
		return
	}
	state, err := h.backend.GetReaderState(request.Context(), currentUser(request).ID, id)
	if err != nil {
		handleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, state)
}

func (h *Handler) putReaderState(writer http.ResponseWriter, request *http.Request) {
	id, ok := pieceID(writer, request)
	if !ok {
		return
	}
	var state app.ReaderState
	if err := decodeJSON(request, &state); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	state, err := h.backend.PutReaderState(request.Context(), currentUser(request).ID, id, state)
	if err != nil {
		handleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, state)
}

func (h *Handler) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		origin := request.Header.Get("Origin")
		if origin != "" && origin == h.allowedOrigin {
			writer.Header().Set("Access-Control-Allow-Origin", origin)
			writer.Header().Set("Access-Control-Allow-Credentials", "true")
			writer.Header().Set("Vary", "Origin")
			writer.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			writer.Header().Set("Access-Control-Allow-Methods", "GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS")
		}
		if request.Method == http.MethodOptions {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func pieceID(writer http.ResponseWriter, request *http.Request) (string, bool) {
	id := chi.URLParam(request, "pieceID")
	if _, err := uuid.Parse(id); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid piece id")
		return "", false
	}
	return id, true
}

func safeFilename(value string) string {
	value = strings.ReplaceAll(value, "\\", "/")
	value = path.Base(value)
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value)
	value = strings.TrimSpace(value)
	if value == "" || value == "." {
		return "score.pdf"
	}
	if !strings.HasSuffix(strings.ToLower(value), ".pdf") {
		value += ".pdf"
	}
	runes := []rune(value)
	if len(runes) > 255 {
		value = string(runes[:251]) + ".pdf"
	}
	return value
}

var errUploadTooLarge = errors.New("upload exceeds configured limit")

type hardLimitReader struct {
	reader io.Reader
	left   int64
}

func (reader *hardLimitReader) Read(buffer []byte) (int, error) {
	if reader.left < 0 {
		return 0, errUploadTooLarge
	}
	limit := int64(len(buffer))
	if limit > reader.left+1 {
		limit = reader.left + 1
	}
	count, err := reader.reader.Read(buffer[:limit])
	reader.left -= int64(count)
	if reader.left < 0 {
		return count, errUploadTooLarge
	}
	return count, err
}

func decodeJSON(request *http.Request, destination any) error {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("request must contain one JSON object")
	}
	return nil
}

func handleError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, app.ErrConflict), errors.Is(err, app.ErrPieceChanged):
		writeError(writer, http.StatusConflict, err.Error())
	case errors.Is(err, app.ErrImportLimit):
		writeError(writer, http.StatusRequestEntityTooLarge, "Import limit reached: max 20 drafts, 200 MiB per draft, and configured per-file limit")
	case errors.Is(err, app.ErrNotFound):
		writeError(writer, http.StatusNotFound, "piece not found")
	case strings.Contains(err.Error(), "must"), strings.Contains(err.Error(), "cannot"):
		writeError(writer, http.StatusBadRequest, err.Error())
	default:
		slog.Error("request failed", "error", err)
		writeError(writer, http.StatusInternalServerError, "internal server error")
	}
}

func writeError(writer http.ResponseWriter, status int, message string) {
	writeJSONStatus(writer, status, map[string]string{"error": message})
}

func writeJSON(writer http.ResponseWriter, status int, body any) {
	writeJSONStatus(writer, status, body)
}

func writeJSONStatus(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(body)
}
