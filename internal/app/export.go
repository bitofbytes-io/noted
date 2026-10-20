package app

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const exportPageSize = 100

// These portability DTOs deliberately exclude storage keys and application URLs.
type exportPiece struct {
	ID           string             `json:"id"`
	Title        string             `json:"title"`
	Composer     string             `json:"composer"`
	Aliases      string             `json:"aliases"`
	Favorite     bool               `json:"favorite"`
	Status       string             `json:"status"`
	SourceURL    string             `json:"sourceUrl"`
	ListeningURL string             `json:"listeningUrl"`
	Notes        string             `json:"notes"`
	CreatedAt    time.Time          `json:"createdAt"`
	UpdatedAt    time.Time          `json:"updatedAt"`
	PDF          *exportPDF         `json:"pdf"`
	ReaderState  *exportReaderState `json:"readerState"`
}
type exportPDF struct {
	Path             string    `json:"path"`
	OriginalFilename string    `json:"originalFilename"`
	SizeBytes        int64     `json:"sizeBytes"`
	ChecksumSHA256   string    `json:"checksumSha256"`
	PageCount        int       `json:"pageCount"`
	UploadedAt       time.Time `json:"uploadedAt"`
}
type exportReaderState struct {
	Mode           string    `json:"mode"`
	LastPage       int       `json:"lastPage"`
	ScrollPosition float64   `json:"scrollPosition"`
	Zoom           float64   `json:"zoom"`
	ScrollSpeed    float64   `json:"scrollSpeed"`
	ScrollPaused   bool      `json:"scrollPaused"`
	UpdatedAt      time.Time `json:"updatedAt"`
}
type exportRecord struct {
	piece exportPiece
	key   string
}
type exportSnapshot interface {
	page(context.Context, string) ([]exportRecord, error)
	commit(context.Context) error
}
type pgExportSnapshot struct {
	tx    pgx.Tx
	owner string
}

func (p pgExportSnapshot) page(ctx context.Context, after string) ([]exportRecord, error) {
	var cursor *string
	if after != "" {
		cursor = &after
	}
	rows, err := p.tx.Query(ctx, `SELECT p.id, p.title, p.composer, p.aliases, p.favorite, p.status,
 p.source_url, p.listening_url, p.notes, p.created_at, p.updated_at, COALESCE(f.storage_key,''),
 CASE WHEN f.piece_id IS NOT NULL THEN jsonb_build_object('originalFilename',f.original_filename,
 'sizeBytes',f.size_bytes,'checksumSha256',f.checksum_sha256,'pageCount',f.page_count,'uploadedAt',f.uploaded_at) END,
 CASE WHEN r.piece_id IS NOT NULL THEN jsonb_build_object('mode',r.mode,'lastPage',r.last_page,
 'scrollPosition',r.scroll_position,'zoom',r.zoom,'scrollSpeed',r.scroll_speed,
 'scrollPaused',r.scroll_paused,'updatedAt',r.updated_at) END
 FROM pieces p LEFT JOIN piece_pdfs f ON f.piece_id=p.id LEFT JOIN reader_states r ON r.piece_id=p.id
 WHERE p.user_id=$1 AND ($2::uuid IS NULL OR p.id>$2::uuid) ORDER BY p.id LIMIT $3`, p.owner, cursor, exportPageSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]exportRecord, 0, exportPageSize)
	for rows.Next() {
		var r exportRecord
		var pdf, state []byte
		v := &r.piece
		if err := rows.Scan(&v.ID, &v.Title, &v.Composer, &v.Aliases, &v.Favorite, &v.Status, &v.SourceURL, &v.ListeningURL, &v.Notes, &v.CreatedAt, &v.UpdatedAt, &r.key, &pdf, &state); err != nil {
			return nil, err
		}
		if pdf != nil {
			if err := json.Unmarshal(pdf, &v.PDF); err != nil {
				return nil, err
			}
		}
		if state != nil {
			if err := json.Unmarshal(state, &v.ReaderState); err != nil {
				return nil, err
			}
		}
		records = append(records, r)
	}
	return records, rows.Err()
}
func (p pgExportSnapshot) commit(ctx context.Context) error { return p.tx.Commit(ctx) }

// ExportLibrary holds one read-only metadata snapshot. PDF objects are immutable,
// but a concurrent deletion may remove one; such an export fails, never omits it.
func (s *Service) ExportLibrary(ctx context.Context, owner string, writer io.Writer) error {
	release, wait := s.exports.acquire(owner)
	if release == nil {
		return &ExportLimitError{RetryAfter: wait}
	}
	defer release()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			slog.Warn("closing export snapshot failed")
		}
	}()
	return streamLibrary(ctx, writer, pgExportSnapshot{tx: tx, owner: owner}, s.store, time.Now().UTC())
}

func streamLibrary(ctx context.Context, writer io.Writer, snapshot exportSnapshot, store assets.Store, now time.Time) error {
	// Fetch the first bounded page before writing any response bytes.
	first, err := snapshot.page(ctx, "")
	if err != nil {
		return err
	}
	walk := func(visit func(exportRecord) error) error {
		page := first
		ordinal := 0
		for {
			for _, r := range page {
				if err := ctx.Err(); err != nil {
					return err
				}
				ordinal++
				if r.piece.PDF != nil {
					pdf := *r.piece.PDF
					pdf.Path, err = exportScorePath(r.piece.Title, r.piece.ID, ordinal)
					if err != nil {
						return err
					}
					r.piece.PDF = &pdf
				}
				if err := visit(r); err != nil {
					return err
				}
			}
			if len(page) < exportPageSize {
				return nil
			}
			page, err = snapshot.page(ctx, page[len(page)-1].piece.ID)
			if err != nil {
				return err
			}
		}
	}
	archive := zip.NewWriter(writer)
	// Do not defer Close: only successful exports receive a central directory.
	manifest, err := archive.CreateHeader(&zip.FileHeader{Name: "library.json", Method: zip.Deflate})
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintf(manifest, "{\"schemaVersion\":1,\"exportedAt\":%q,\"pieces\":[", now.UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	firstPiece := true
	err = walk(func(r exportRecord) error {
		if !firstPiece {
			if _, err := io.WriteString(manifest, ","); err != nil {
				return err
			}
		}
		firstPiece = false
		return json.NewEncoder(manifest).Encode(r.piece)
	})
	if err != nil {
		return err
	}
	if _, err = io.WriteString(manifest, "]}\n"); err != nil {
		return err
	}
	csvEntry, err := archive.CreateHeader(&zip.FileHeader{Name: "pieces.csv", Method: zip.Deflate})
	if err != nil {
		return err
	}
	table := csv.NewWriter(csvEntry)
	if err = table.Write([]string{"id", "title", "composer", "aliases", "favorite", "status", "sourceUrl", "listeningUrl", "notes", "createdAt", "updatedAt", "pdfPath", "originalFilename", "sizeBytes", "checksumSha256", "pageCount", "uploadedAt", "readerState"}); err != nil {
		return err
	}
	err = walk(func(r exportRecord) error {
		p := r.piece
		fields := []string{p.ID, p.Title, p.Composer, p.Aliases, strconv.FormatBool(p.Favorite), p.Status, p.SourceURL, p.ListeningURL, p.Notes, p.CreatedAt.Format(time.RFC3339Nano), p.UpdatedAt.Format(time.RFC3339Nano), "", "", "", "", "", "", ""}
		if p.PDF != nil {
			f := p.PDF
			copy(fields[11:], []string{f.Path, f.OriginalFilename, strconv.FormatInt(f.SizeBytes, 10), f.ChecksumSHA256, strconv.Itoa(f.PageCount), f.UploadedAt.Format(time.RFC3339Nano)})
		}
		if p.ReaderState != nil {
			data, err := json.Marshal(p.ReaderState)
			if err != nil {
				return err
			}
			fields[17] = string(data)
		}
		for i, value := range fields {
			fields[i] = exportCSVCell(value)
		}
		return table.Write(fields)
	})
	if err != nil {
		return err
	}
	table.Flush()
	if err = table.Error(); err != nil {
		return err
	}
	if err = archive.Flush(); err != nil {
		return err
	}
	buffer := make([]byte, 32<<10)
	err = walk(func(r exportRecord) error {
		if r.piece.PDF == nil {
			return nil
		}
		return writeExportScore(ctx, archive, store, r, buffer)
	})
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// A failed transaction must not leave a valid-looking archive.
	if err = snapshot.commit(ctx); err != nil {
		return err
	}
	return archive.Close()
}

func writeExportScore(ctx context.Context, archive *zip.Writer, store assets.Store, r exportRecord, buffer []byte) (err error) {
	pdf := r.piece.PDF
	if pdf.SizeBytes <= 0 {
		return errors.New("invalid export asset size")
	}
	digest, err := hex.DecodeString(pdf.ChecksumSHA256)
	if err != nil || len(digest) != sha256.Size {
		return errors.New("invalid export asset checksum")
	}
	reader, err := store.Open(ctx, r.key)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, reader.Close()) }()
	entry, err := archive.CreateHeader(&zip.FileHeader{Name: pdf.Path, Method: zip.Store})
	if err != nil {
		return err
	}
	hash := sha256.New()
	output := io.MultiWriter(entry, hash)
	var copied int64
	emptyReads := 0
	for copied < pdf.SizeBytes {
		if err = ctx.Err(); err != nil {
			return err
		}
		size := min(int64(len(buffer)), pdf.SizeBytes-copied)
		n, readErr := reader.Read(buffer[:size])
		if err = ctx.Err(); err != nil {
			return err
		}
		if n > 0 {
			if _, err = output.Write(buffer[:n]); err != nil {
				return err
			}
			copied += int64(n)
			emptyReads = 0
		} else {
			emptyReads++
			if emptyReads >= 100 {
				return io.ErrNoProgress
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) && copied == pdf.SizeBytes {
				break
			}
			return errors.Join(errors.New("export asset read failed"), readErr)
		}
	}
	// Verify EOF even when the final full-sized read returned no error.
	for i := 0; i < 100; i++ {
		if err = ctx.Err(); err != nil {
			return err
		}
		n, readErr := reader.Read(buffer[:1])
		if n != 0 {
			return errors.New("export asset exceeds recorded size")
		}
		if errors.Is(readErr, io.EOF) {
			if hex.EncodeToString(hash.Sum(nil)) != pdf.ChecksumSHA256 {
				return errors.New("export asset checksum changed")
			}
			return ctx.Err()
		}
		if readErr != nil {
			return readErr
		}
	}
	return io.ErrNoProgress
}

func exportScorePath(title, id string, ordinal int) (string, error) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", err
	}
	var name strings.Builder
	for _, r := range title {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		if strings.ContainsRune(`/\<>:"|?*`, r) {
			r = '-'
		}
		if name.Len()+len(string(r)) > 120 {
			break
		}
		name.WriteRune(r)
	}
	base := strings.Trim(name.String(), " .")
	if base == "" {
		base = "score"
	}
	// The keyset ordinal makes even identical titles/short UUID prefixes unique,
	// deterministically across all three snapshot passes, without a name map.
	// Prefix the entire basename so dotted Windows device names (CON.txt, etc.)
	// cannot remain reserved even when a unique suffix follows their extension.
	return "scores/score-" + base + "-" + parsed.String()[:8] + "-" + strconv.Itoa(ordinal) + ".pdf", nil
}
func exportCSVCell(value string) string {
	significant := strings.TrimLeftFunc(value, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) })
	if strings.HasPrefix(value, "\t") || strings.HasPrefix(value, "\r") || strings.HasPrefix(value, "\n") || (significant != "" && strings.ContainsRune("=+-@", rune(significant[0]))) {
		return "'" + value
	}
	return value
}
