package app

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"time"
)

// ErrNotPDF means a Send to Noted upload was not a PDF.
var ErrNotPDF = errors.New("only PDF files can be sent")

// ShortcutImport reports where a PDF sent from the iOS Shortcut landed.
// Headline and Message are the notification the Shortcut shows as is, so its
// copy lives here, under test, rather than in Shortcut actions.
type ShortcutImport struct {
	DraftID   string `json:"draftId"`
	DraftPath string `json:"draftPath"`
	Title     string `json:"title"`
	Composer  string `json:"composer"`
	Filename  string `json:"filename"`
	Headline  string `json:"headline"`
	Message   string `json:"message"`
}

// AllowShortcutImport applies the per-user Send to Noted limit (10 a minute).
func (s *Service) AllowShortcutImport(owner string) bool {
	return s.shortcuts.allow(owner)
}

// ShortcutImport files a PDF sent from the iOS Shortcut as a new draft,
// prefilled from the work when the filename names an IMSLP file. It never
// looks for an existing draft: starting in Noted goes through the IMSLP panel's
// own Add downloaded PDF. The filename is stored as the source's name and is
// never a storage path.
func (s *Service) ShortcutImport(ctx context.Context, owner, filename string, reader io.Reader) (ShortcutImport, error) {
	data, err := io.ReadAll(io.LimitReader(reader, s.importLimit()+1))
	if err != nil {
		return ShortcutImport{}, err
	}
	if int64(len(data)) > s.importLimit() {
		return ShortcutImport{}, ErrImportLimit
	}
	// Images are valid draft sources elsewhere, but the Shortcut sends PDFs only.
	if !bytes.HasPrefix(data, []byte("%PDF-")) {
		return ShortcutImport{}, ErrNotPDF
	}
	mime, pages, width, height, err := ValidateImportBytes(data)
	if err != nil {
		return ShortcutImport{}, err
	}
	source := validatedSource{data: data, mime: mime, pages: pages, width: width, height: height}

	var work *IMSLPWork
	if number, ok := imslpFileNumberOf(filename); ok {
		if found, ok := s.imslp.resolveFile(number); ok {
			work = &found
		}
	}
	input := CreateImport{}
	if work != nil {
		input.SourceURL = work.URL
	}
	d, err := s.createImport(ctx, owner, input, work)
	if err != nil {
		return ShortcutImport{}, err
	}
	// Without a work the title comes from the filename, as for any first upload.
	attached, err := s.attachSource(ctx, owner, d.ID, filename, d.Revision, source)
	if err != nil {
		// Do not leave an empty draft behind for a file that never arrived.
		_ = s.DeleteImport(context.WithoutCancel(ctx), owner, d.ID)
		return ShortcutImport{}, err
	}
	return shortcutResult(attached, filename), nil
}

func shortcutResult(d ImportDraft, filename string) ShortcutImport {
	result := ShortcutImport{
		DraftID:   d.ID,
		DraftPath: "/prepare/" + d.ID,
		Title:     d.Metadata.Title,
		Composer:  d.Metadata.Composer,
		Filename:  filename,
		Headline:  d.Metadata.Title,
		Message:   "New draft created.",
	}
	if result.Headline == "" {
		result.Headline = "Untitled score"
	}
	if result.Composer != "" {
		result.Headline += " — " + result.Composer
	}
	return result
}

// userLimiter is a token bucket per user with idle buckets swept away, like the
// IMSLP search limit.
type userLimiter struct {
	rate  float64
	burst int
	idle  time.Duration
	now   func() time.Time

	mu        sync.Mutex
	users     map[string]*imslpUserBucket
	nextSweep time.Time
}

func newUserLimiter(rate float64, burst int, idle time.Duration, now func() time.Time) *userLimiter {
	return &userLimiter{rate: rate, burst: burst, idle: idle, now: now, users: map[string]*imslpUserBucket{}}
}

func (l *userLimiter) allow(userID string) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if !now.Before(l.nextSweep) {
		for id, user := range l.users {
			if now.Sub(user.seen) >= l.idle {
				delete(l.users, id)
			}
		}
		l.nextSweep = now.Add(l.idle)
	}
	user := l.users[userID]
	if user == nil {
		user = &imslpUserBucket{}
		l.users[userID] = user
	}
	user.seen = now
	return user.bucket.allow(now, l.rate, l.burst)
}
