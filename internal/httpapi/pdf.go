package httpapi

import (
	"mime"
	"net/http"
	"path"
	"strings"
	"unicode"
)

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
	defer reader.Close() //nolint:errcheck // Read-only stream; the read/response result is handled separately.
	filename := safeFilename(source.OriginalFilename)
	disposition := mime.FormatMediaType(dispositionType, map[string]string{"filename": filename})
	writer.Header().Set("Content-Type", "application/pdf")
	writer.Header().Set("Content-Disposition", disposition)
	writer.Header().Set("Accept-Ranges", "bytes")
	writer.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	http.ServeContent(writer, request, filename, source.UploadedAt, reader)
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
