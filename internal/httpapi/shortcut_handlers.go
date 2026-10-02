package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/auth"
)

// ShortcutTokens stores each user's one Send to Noted bearer token.
type ShortcutTokens interface {
	ShortcutTokenStatus(context.Context, string) (auth.ShortcutTokenStatus, error)
	CreateShortcutToken(context.Context, string) (string, time.Time, error)
	DeleteShortcutToken(context.Context, string) error
	ResolveShortcutToken(context.Context, string) (app.User, error)
	TouchShortcutToken(context.Context, string) error
}

type shortcutBackend interface {
	AllowShortcutImport(string) bool
	ShortcutImport(context.Context, string, string, io.Reader) (app.ShortcutImport, error)
}

// The router finds both by type assertion, so a signature drift must fail the build.
var (
	_ ShortcutTokens  = (*auth.Service)(nil)
	_ shortcutBackend = (*app.Service)(nil)
)

// The Shortcut shows the error text as its notification, so these are sentences.
const (
	shortcutTokenInvalid = "This shortcut was turned off. Set it up again in Noted."
	shortcutNotPDF       = "Only PDF files can be sent."
	shortcutTooLarge     = "File is larger than Noted allows."
	shortcutNoFile       = "Send the PDF as the form field named file."
	shortcutTooFast      = "Too many files sent in a minute. Wait a moment and send again."
	shortcutDraftLimit   = "You have 20 open drafts. Finish or delete one in Noted, then send again."
	shortcutStoreFailed  = "Noted couldn't store the file. Try again later."
)

func (h *Handler) shortcutTokens(w http.ResponseWriter) (ShortcutTokens, bool) {
	tokens, ok := h.auth.(ShortcutTokens)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "Send to Noted is unavailable")
	}
	return tokens, ok
}

func (h *Handler) shortcutTokenStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	tokens, ok := h.shortcutTokens(w)
	if !ok {
		return
	}
	status, err := tokens.ShortcutTokenStatus(r.Context(), currentUser(r).ID)
	if err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// createShortcutToken creates or replaces the token. Its plaintext is in this
// response only.
func (h *Handler) createShortcutToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	tokens, ok := h.shortcutTokens(w)
	if !ok {
		return
	}
	token, createdAt, err := tokens.CreateShortcutToken(r.Context(), currentUser(r).ID)
	if err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"token": token, "createdAt": createdAt, "installUrl": h.config.ShortcutInstallURL,
	})
}

func (h *Handler) deleteShortcutToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	tokens, ok := h.shortcutTokens(w)
	if !ok {
		return
	}
	if err := tokens.DeleteShortcutToken(r.Context(), currentUser(r).ID); err != nil {
		handleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// shortcutUser authenticates the one Shortcut route by bearer token alone: no
// session cookie, and no automatic user in development mode.
func (h *Handler) shortcutUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		reject := func() {
			w.Header().Set("WWW-Authenticate", `Bearer realm="noted"`)
			writeError(w, http.StatusUnauthorized, shortcutTokenInvalid)
		}
		tokens, ok := h.auth.(ShortcutTokens)
		token, wellFormed := bearerToken(r.Header.Get("Authorization"))
		if !ok || !wellFormed {
			reject()
			return
		}
		user, err := tokens.ResolveShortcutToken(r.Context(), token)
		if errors.Is(err, auth.ErrNotAuthenticated) || (err == nil && !h.shortcutOwnerAllowed(user)) {
			reject()
			return
		}
		if err != nil {
			handleError(w, err)
			return
		}
		// Best effort: a missed "last used" never blocks the upload.
		if err := tokens.TouchShortcutToken(r.Context(), token); err != nil {
			slog.Warn("shortcut token use was not recorded", "user", user.ID, "error", err)
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userContextKey{}, user)))
	})
}

// bearerToken accepts only the shape randomToken issues (32 bytes, base64url),
// so malformed headers never reach the database.
func bearerToken(header string) (string, bool) {
	scheme, token, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || len(token) != 43 {
		return "", false
	}
	for _, r := range token {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return "", false
		}
	}
	return token, true
}

// A token outlives sessions, so its owner must still be allowed in the current
// auth mode: the seeded learner in development, an allow-listed email with Google.
func (h *Handler) shortcutOwnerAllowed(user app.User) bool {
	email := strings.ToLower(strings.TrimSpace(user.Email))
	if h.config.AuthMode == "development" {
		return email != "" && email == h.config.DevUserEmail
	}
	return slices.Contains(h.config.AllowedEmails, email)
}

func (h *Handler) shortcutImport(w http.ResponseWriter, r *http.Request) {
	backend, ok := h.backend.(shortcutBackend)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "Send to Noted is unavailable")
		return
	}
	user := currentUser(r)
	if !backend.AllowShortcutImport(user.ID) {
		w.Header().Set("Retry-After", "6")
		writeError(w, http.StatusTooManyRequests, shortcutTooFast)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, h.maxUploadBytes+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, shortcutTooLarge)
			return
		}
		writeError(w, http.StatusBadRequest, shortcutNoFile)
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, shortcutNoFile)
		return
	}
	defer file.Close()
	if header.Size > h.maxUploadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, shortcutTooLarge)
		return
	}
	if !isPDFPart(header) {
		writeError(w, http.StatusUnsupportedMediaType, shortcutNotPDF)
		return
	}
	result, err := backend.ShortcutImport(
		r.Context(), user.ID, importFilename(header),
		&hardLimitReader{reader: file, left: h.maxUploadBytes},
	)
	switch {
	case errors.Is(err, app.ErrNotPDF):
		writeError(w, http.StatusUnsupportedMediaType, shortcutNotPDF)
	case errors.Is(err, app.ErrDraftLimit):
		writeError(w, http.StatusTooManyRequests, shortcutDraftLimit)
	case errors.Is(err, app.ErrImportLimit), errors.Is(err, errUploadTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, shortcutTooLarge)
	case errors.Is(err, app.ErrAssetStore):
		slog.Error("shortcut import could not store the file", "user", user.ID, "error", err)
		writeError(w, http.StatusServiceUnavailable, shortcutStoreFailed)
	case err != nil:
		handleError(w, err)
	default:
		// Never log the filename: it names the user's score.
		slog.Info("shortcut import accepted", "user", user.ID, "matched", result.Matched)
		writeJSON(w, http.StatusCreated, result)
	}
}

// isPDFPart is the drop target's rule: a PDF type or a .pdf name. The bytes are
// checked again before anything is stored.
func isPDFPart(header *multipart.FileHeader) bool {
	if strings.EqualFold(path.Ext(header.Filename), ".pdf") {
		return true
	}
	mediaType, _, err := mime.ParseMediaType(header.Header.Get("Content-Type"))
	return err == nil && mediaType == "application/pdf"
}

// importFilename keeps only the base name of an uploaded file for display. It
// is stored as a database value and never used as a storage path.
func importFilename(header *multipart.FileHeader) string {
	filename := path.Base(strings.ReplaceAll(header.Filename, "\\", "/"))
	if len(filename) > 255 || filename == "." {
		filename = "Imported score"
	}
	return filename
}
