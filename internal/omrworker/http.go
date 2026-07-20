package omrworker

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const (
	DefaultMaxInputBytes = int64(25 << 20)
	DefaultTimeout       = 10 * time.Minute
	DefaultUploadTimeout = 2 * time.Minute
	requestOverhead      = int64(1 << 20)
)

type Config struct {
	Token         string
	TempRoot      string
	MaxInputBytes int64
	Timeout       time.Duration
	UploadTimeout time.Duration
	Recognizer    Recognizer
	Logger        *slog.Logger
}

type Handler struct {
	tokenDigest   [sha256.Size]byte
	tempRoot      string
	maxInputBytes int64
	timeout       time.Duration
	uploadTimeout time.Duration
	recognizer    Recognizer
	logger        *slog.Logger
	slot          chan struct{}
	router        *http.ServeMux
}

func NewHandler(config Config) (*Handler, error) {
	if strings.TrimSpace(config.Token) == "" {
		return nil, errors.New("worker bearer token is required")
	}
	if config.Recognizer == nil {
		return nil, errors.New("recognizer is required")
	}
	if config.TempRoot == "" {
		config.TempRoot = os.TempDir()
	}
	if err := os.MkdirAll(config.TempRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create worker temporary root: %w", err)
	}
	staleJobs, err := filepath.Glob(filepath.Join(config.TempRoot, "noted-omr-job-*"))
	if err != nil {
		return nil, fmt.Errorf("list interrupted worker jobs: %w", err)
	}
	for _, staleJob := range staleJobs {
		if err := os.RemoveAll(staleJob); err != nil {
			return nil, fmt.Errorf("remove interrupted worker job: %w", err)
		}
	}
	if config.MaxInputBytes <= 0 {
		config.MaxInputBytes = DefaultMaxInputBytes
	}
	if config.Timeout <= 0 {
		config.Timeout = DefaultTimeout
	}
	if config.UploadTimeout <= 0 {
		config.UploadTimeout = DefaultUploadTimeout
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	handler := &Handler{
		tokenDigest:   sha256.Sum256([]byte(config.Token)),
		tempRoot:      config.TempRoot,
		maxInputBytes: config.MaxInputBytes,
		timeout:       config.Timeout,
		uploadTimeout: config.UploadTimeout,
		recognizer:    config.Recognizer,
		logger:        config.Logger,
		slot:          make(chan struct{}, 1),
		router:        http.NewServeMux(),
	}
	handler.router.HandleFunc("/healthz", handler.health)
	handler.router.HandleFunc("/readyz", handler.ready)
	handler.router.HandleFunc("/v1/recognize", handler.recognize)
	handler.router.HandleFunc("/v1/measure-map", handler.measureMap)
	return handler, nil
}

func (h *Handler) measureMap(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		h.writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "method is not allowed")
		return
	}
	if !h.authorized(request) {
		response.Header().Set("WWW-Authenticate", `Bearer realm="noted-omr"`)
		h.writeError(response, http.StatusUnauthorized, "unauthorized", "valid bearer authentication is required")
		return
	}
	mapper, ok := h.recognizer.(MeasureMapper)
	if !ok {
		h.writeError(response, http.StatusServiceUnavailable, "worker_unavailable", "measure mapping is unavailable")
		return
	}
	select {
	case h.slot <- struct{}{}:
		defer func() { <-h.slot }()
	default:
		response.Header().Set("Retry-After", "5")
		h.writeError(response, http.StatusTooManyRequests, "busy", "recognition worker is processing another score")
		return
	}
	jobDirectory, err := os.MkdirTemp(h.tempRoot, "noted-omr-job-")
	if err != nil {
		h.writeError(response, http.StatusInternalServerError, "internal_error", "temporary job storage could not be created")
		return
	}
	defer func() { _ = os.RemoveAll(jobDirectory) }()
	inputPath := filepath.Join(jobDirectory, "input.bin")
	if err := h.receivePDF(response, request, inputPath); err != nil {
		h.writeWorkerError(response, err)
		return
	}
	outputDirectory := filepath.Join(jobDirectory, "output")
	if err := os.Mkdir(outputDirectory, 0o700); err != nil {
		h.writeError(response, http.StatusInternalServerError, "internal_error", "temporary output storage could not be created")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.timeout)
	defer cancel()
	result, err := mapper.MapMeasures(ctx, inputPath, outputDirectory)
	if err != nil {
		h.writeWorkerError(response, err)
		return
	}
	h.writeJSON(response, http.StatusOK, result)
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	h.router.ServeHTTP(response, request)
}

func (h *Handler) health(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		h.writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "method is not allowed")
		return
	}
	h.writeJSON(response, http.StatusOK, map[string]any{"status": "ok"})
}

func (h *Handler) ready(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		h.writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "method is not allowed")
		return
	}
	jobDirectory, err := os.MkdirTemp(h.tempRoot, "noted-omr-ready-")
	if err != nil {
		h.writeError(response, http.StatusServiceUnavailable, "worker_unavailable", "temporary storage is not writable")
		return
	}
	if err := os.RemoveAll(jobDirectory); err != nil {
		h.writeError(response, http.StatusServiceUnavailable, "worker_unavailable", "temporary storage cleanup failed")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 30*time.Second)
	defer cancel()
	version, err := h.recognizer.Ready(ctx)
	if err != nil {
		h.writeError(response, http.StatusServiceUnavailable, codeForError(err, "worker_unavailable"), "recognition engine is unavailable")
		return
	}
	h.writeJSON(response, http.StatusOK, map[string]any{"status": "ready", "engine": EngineName, "version": version})
}

func (h *Handler) recognize(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		h.writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "method is not allowed")
		return
	}
	if !h.authorized(request) {
		response.Header().Set("WWW-Authenticate", `Bearer realm="noted-omr"`)
		h.writeError(response, http.StatusUnauthorized, "unauthorized", "valid bearer authentication is required")
		return
	}
	select {
	case h.slot <- struct{}{}:
		defer func() { <-h.slot }()
	default:
		response.Header().Set("Retry-After", "5")
		h.writeError(response, http.StatusTooManyRequests, "busy", "recognition worker is processing another score")
		return
	}

	jobDirectory, err := os.MkdirTemp(h.tempRoot, "noted-omr-job-")
	if err != nil {
		h.writeError(response, http.StatusInternalServerError, "internal_error", "temporary job storage could not be created")
		return
	}
	defer func() {
		if err := os.RemoveAll(jobDirectory); err != nil {
			h.logger.Error("remove OCR job directory", "error", err)
		}
	}()
	inputName := "input.pdf"
	if strings.EqualFold(strings.TrimSpace(request.Header.Get("X-Noted-Source-Type")), "image") {
		inputName = "input.jpg"
	}
	inputPath := filepath.Join(jobDirectory, inputName)
	var uploadTimedOut atomic.Bool
	uploadBody := request.Body
	uploadTimerDone := make(chan struct{})
	uploadTimer := time.AfterFunc(h.uploadTimeout, func() {
		uploadTimedOut.Store(true)
		_ = uploadBody.Close()
		close(uploadTimerDone)
	})
	receiveErr := h.receivePDF(response, request, inputPath)
	if !uploadTimer.Stop() {
		<-uploadTimerDone
	}
	if uploadTimedOut.Load() {
		h.writeWorkerError(response, workerError("timeout", "PDF upload exceeded its time limit", nil))
		return
	}
	if receiveErr != nil {
		h.writeWorkerError(response, receiveErr)
		return
	}

	outputDirectory := filepath.Join(jobDirectory, "output")
	if err := os.Mkdir(outputDirectory, 0o700); err != nil {
		h.writeError(response, http.StatusInternalServerError, "internal_error", "temporary output storage could not be created")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.timeout)
	defer cancel()
	options := RecognitionOptions{SourceType: strings.ToLower(strings.TrimSpace(request.Header.Get("X-Noted-Source-Type")))}
	if options.SourceType == "" {
		options.SourceType = "pdf"
	}
	if options.SourceType != "pdf" && options.SourceType != "image" {
		h.writeError(response, http.StatusUnprocessableEntity, "invalid_request", "source type must be pdf or image")
		return
	}
	options.ImplicitTuplets = strings.EqualFold(strings.TrimSpace(request.Header.Get("X-Noted-Implicit-Tuplets")), "true")
	var result Result
	if optionRecognizer, ok := h.recognizer.(OptionRecognizer); ok {
		result, err = optionRecognizer.RecognizeWithOptions(ctx, inputPath, outputDirectory, options)
	} else {
		result, err = h.recognizer.Recognize(ctx, inputPath, outputDirectory)
	}
	if err != nil {
		h.logger.Warn("OCR conversion failed", "code", codeForError(err, "conversion_failed"), "error", err)
		h.writeWorkerError(response, err)
		return
	}

	score, err := os.Open(result.Path)
	if err != nil {
		h.writeError(response, http.StatusBadGateway, "invalid_output", "recognition output could not be opened")
		return
	}
	defer score.Close()
	scoreInfo, err := score.Stat()
	if err != nil {
		h.writeError(response, http.StatusBadGateway, "invalid_output", "recognition output could not be measured")
		return
	}
	engine := strings.TrimSpace(result.Engine)
	if engine == "" || engine == "fusion" {
		engine = EngineName
	}
	response.Header().Set("X-Noted-OMR-Engine", engine)
	response.Header().Set("X-Noted-OMR-Version", EngineVersion)
	response.Header().Set("Cache-Control", "no-store")
	if result.ProjectPath == "" && result.Report == nil {
		response.Header().Set("Content-Type", result.ContentType)
		response.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="recognized%s"`, result.Extension))
		response.Header().Set("Content-Length", strconv.FormatInt(scoreInfo.Size(), 10))
		response.WriteHeader(http.StatusOK)
		if _, err := io.Copy(response, score); err != nil {
			h.logger.Warn("stream OCR output", "error", err)
		}
		return
	}

	var project *os.File
	if result.ProjectPath != "" {
		project, err = os.Open(result.ProjectPath)
		if err != nil {
			h.writeError(response, http.StatusBadGateway, "invalid_output", "recognition project could not be opened")
			return
		}
		defer project.Close()
	}
	if result.Report != nil {
		if err := result.Report.Validate(); err != nil {
			h.writeError(response, http.StatusBadGateway, "invalid_output", "recognition quality report is invalid")
			return
		}
	}
	writer := multipart.NewWriter(response)
	response.Header().Set("Content-Type", "multipart/mixed; boundary="+writer.Boundary())
	response.WriteHeader(http.StatusOK)
	if err := writeArtifactPart(writer, score, "score", "recognized"+result.Extension, result.ContentType); err != nil {
		h.logger.Warn("stream OCR score output", "error", err)
		return
	}
	if project != nil {
		if err := writeArtifactPart(writer, project, "project", "recognized.omr", "application/octet-stream"); err != nil {
			h.logger.Warn("stream OCR project output", "error", err)
			return
		}
	}
	if result.Report != nil {
		if err := writeJSONArtifactPart(writer, result.Report, "report", "quality-report.json"); err != nil {
			h.logger.Warn("stream OCR quality report", "error", err)
			return
		}
	}
	if err := writer.Close(); err != nil {
		h.logger.Warn("finish OCR multipart output", "error", err)
	}
}

func writeJSONArtifactPart(writer *multipart.Writer, value any, artifact, filename string) error {
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`attachment; name="%s"; filename="%s"`, artifact, filename))
	header.Set("Content-Type", "application/json")
	header.Set("X-Noted-Artifact", artifact)
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	return json.NewEncoder(part).Encode(value)
}

func writeArtifactPart(writer *multipart.Writer, reader io.Reader, artifact, filename, contentType string) error {
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`attachment; name="%s"; filename="%s"`, artifact, filename))
	header.Set("Content-Type", contentType)
	header.Set("X-Noted-Artifact", artifact)
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(part, reader)
	return err
}

func (h *Handler) receivePDF(response http.ResponseWriter, request *http.Request, path string) error {
	request.Body = http.MaxBytesReader(response, request.Body, h.maxInputBytes+requestOverhead)
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		return workerError("invalid_request", "request must use multipart/form-data", err)
	}
	reader, err := request.MultipartReader()
	if err != nil {
		return workerError("invalid_request", "multipart request could not be read", err)
	}
	found := false
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				return workerError("input_too_large", "PDF exceeds the 25 MiB limit", err)
			}
			return workerError("invalid_request", "multipart request could not be read", err)
		}
		if part.FormName() != "file" || part.FileName() == "" {
			_ = part.Close()
			continue
		}
		if found {
			_ = part.Close()
			return workerError("invalid_request", "request must contain exactly one PDF file", nil)
		}
		found = true
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			_ = part.Close()
			return workerError("internal_error", "temporary input could not be created", err)
		}
		written, copyErr := io.Copy(file, io.LimitReader(part, h.maxInputBytes+1))
		closeErr := file.Close()
		_ = part.Close()
		if copyErr != nil {
			return workerError("invalid_request", "PDF upload could not be read", copyErr)
		}
		if closeErr != nil {
			return workerError("internal_error", "temporary input could not be written", closeErr)
		}
		if written > h.maxInputBytes {
			return workerError("input_too_large", "PDF exceeds the 25 MiB limit", nil)
		}
	}
	if !found {
		return workerError("invalid_request", "multipart field file is required", nil)
	}
	if err := validatePDF(path); err != nil {
		return err
	}
	return nil
}

func validatePDF(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return workerError("invalid_pdf", "PDF could not be inspected", err)
	}
	defer file.Close()
	header := make([]byte, 1024)
	read, err := file.Read(header)
	if err != nil && !errors.Is(err, io.EOF) {
		return workerError("invalid_pdf", "PDF could not be inspected", err)
	}
	data := header[:read]
	isPDF := strings.Contains(string(data), "%PDF-")
	isPNG := len(data) >= 8 && string(data[:8]) == "\x89PNG\r\n\x1a\n"
	isJPEG := len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff
	if !isPDF && !isPNG && !isJPEG {
		return workerError("invalid_pdf", "uploaded file is not a PDF, PNG, or JPEG score", nil)
	}
	return nil
}

func (h *Handler) authorized(request *http.Request) bool {
	scheme, supplied, ok := strings.Cut(strings.TrimSpace(request.Header.Get("Authorization")), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || supplied == "" {
		return false
	}
	suppliedDigest := sha256.Sum256([]byte(supplied))
	return subtle.ConstantTimeCompare(suppliedDigest[:], h.tokenDigest[:]) == 1
}

func (h *Handler) writeWorkerError(response http.ResponseWriter, err error) {
	code := codeForError(err, "internal_error")
	status := http.StatusInternalServerError
	switch code {
	case "invalid_request", "invalid_pdf", "unplayable_output":
		status = http.StatusUnprocessableEntity
	case "input_too_large":
		status = http.StatusRequestEntityTooLarge
	case "too_many_pages", "conversion_failed":
		status = http.StatusUnprocessableEntity
	case "busy":
		status = http.StatusTooManyRequests
	case "timeout":
		status = http.StatusGatewayTimeout
	case "cancelled":
		status = 499
	case "invalid_output", "output_too_large":
		status = http.StatusBadGateway
	case "worker_unavailable", "worker_version_mismatch":
		status = http.StatusServiceUnavailable
	}
	message := "recognition request failed"
	var workerErr *Error
	if errors.As(err, &workerErr) {
		message = workerErr.Message
	}
	h.writeError(response, status, code, message)
}

func codeForError(err error, fallback string) string {
	var workerErr *Error
	if errors.As(err, &workerErr) && workerErr.Code != "" {
		return workerErr.Code
	}
	return fallback
}

func (h *Handler) writeError(response http.ResponseWriter, status int, code, message string) {
	h.writeJSON(response, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func (h *Handler) writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	if err := json.NewEncoder(response).Encode(value); err != nil {
		h.logger.Warn("write JSON response", "error", err)
	}
}
