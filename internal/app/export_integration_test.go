package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func exportIntegrationSetup(t *testing.T) (context.Context, *Service, string, string) {
	t.Helper()
	dsn := os.Getenv("NOTED_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store, err := assets.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner, other := uuid.NewString(), uuid.NewString()
	for _, id := range []string{owner, other} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,display_name,auth_provider) VALUES($1,$2,'Export tester','development')`, id, id+"@example.test"); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		for _, query := range []string{`DELETE FROM import_drafts WHERE user_id=ANY($1::uuid[])`, `DELETE FROM pieces WHERE user_id=ANY($1::uuid[])`, `DELETE FROM users WHERE id=ANY($1::uuid[])`} {
			if _, err := pool.Exec(context.Background(), query, []string{owner, other}); err != nil {
				t.Error(err)
			}
		}
	})
	return ctx, NewService(pool, store), owner, other
}
func exportIntegrationPDF(t *testing.T, ctx context.Context, s *Service, owner string, data []byte) (Piece, assets.Object) {
	t.Helper()
	piece, err := s.CreatePiece(ctx, owner, PieceInput{Title: "Private score", Opus: "Op. 10", MusicKey: "C♯ minor", Aliases: "Other title", SourceURL: "https://example.test/source", ListeningURL: "https://example.test/listen", Notes: "=private note", Favorite: true})
	if err != nil {
		t.Fatal(err)
	}
	object, err := s.store.Save(ctx, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO piece_pdfs(piece_id,storage_key,original_filename,size_bytes,checksum_sha256,page_count) VALUES($1,$2,'../original.pdf',$3,$4,2)`, piece.ID, object.Key, object.Size, object.Checksum); err != nil {
		t.Fatal(err)
	}
	return piece, object
}

type exportHookWriter struct {
	io.Writer
	hook   func() error
	called bool
}

func (w *exportHookWriter) Write(p []byte) (int, error) {
	if !w.called {
		w.called = true
		if err := w.hook(); err != nil {
			return 0, err
		}
	}
	return w.Writer.Write(p)
}

func TestIntegrationLibraryExportOwnershipPagingAndSnapshot(t *testing.T) {
	ctx, s, owner, other := exportIntegrationSetup(t)
	original := []byte("rights-safe original score")
	score, old := exportIntegrationPDF(t, ctx, s, owner, original)
	if _, err := s.pool.Exec(ctx, `INSERT INTO reader_states(piece_id,mode,last_page,zoom,scroll_speed,scroll_paused) VALUES($1,'scroll',2,1.5,7,false)`, score.ID); err != nil {
		t.Fatal(err)
	}
	ids := []string{score.ID}
	for i := 1; i < 205; i++ {
		status := []string{StatusLearning, StatusPlaying, StatusShelved}[i%3]
		piece, err := s.CreatePiece(ctx, owner, PieceInput{Title: "Metadata only", Status: &status})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, piece.ID)
	}
	exportIntegrationPDF(t, ctx, s, other, []byte("OTHER OWNER PRIVATE PDF"))
	if _, err := s.CreateImport(ctx, owner, CreateImport{}); err != nil {
		t.Fatal(err)
	}
	sort.Strings(ids)
	replacement, err := s.store.Save(ctx, strings.NewReader("new immutable object"))
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := tx.Rollback(context.Background()); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Error(err)
		}
	}()
	var isolation, readOnly string
	if err := tx.QueryRow(ctx, `SELECT current_setting('transaction_isolation'),current_setting('transaction_read_only')`).Scan(&isolation, &readOnly); err != nil || isolation != "repeatable read" || readOnly != "on" {
		t.Fatal(isolation, readOnly, err)
	}
	var output bytes.Buffer
	writer := &exportHookWriter{Writer: &output, hook: func() error {
		// This would fail with "conn busy" if SQL rows remained open during writes.
		var one int
		if err := tx.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil {
			return err
		}
		if _, err := s.pool.Exec(ctx, `UPDATE pieces SET title='CHANGED AFTER SNAPSHOT' WHERE id=$1`, ids[150]); err != nil {
			return err
		}
		if _, err := s.pool.Exec(ctx, `UPDATE piece_pdfs SET storage_key=$2,size_bytes=$3,checksum_sha256=$4 WHERE piece_id=$1`, score.ID, replacement.Key, replacement.Size, replacement.Checksum); err != nil {
			return err
		}
		_, err := s.CreatePiece(ctx, owner, PieceInput{Title: "ADDED AFTER SNAPSHOT"})
		return err
	}}
	if err := streamLibrary(ctx, writer, pgExportSnapshot{tx: tx, owner: owner}, s.store, time.Now()); err != nil {
		t.Fatal(err)
	}
	files := readExportZIP(t, output.Bytes())
	var manifest struct {
		Pieces []exportPiece `json:"pieces"`
	}
	if err := json.Unmarshal(files["library.json"], &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Pieces) != 205 || !writer.called {
		t.Fatalf("pieces=%d hook=%v", len(manifest.Pieces), writer.called)
	}
	counts := map[string]int{}
	saved := 0
	for _, piece := range manifest.Pieces {
		counts[piece.Status]++
		if piece.Title == "CHANGED AFTER SNAPSHOT" || piece.Title == "ADDED AFTER SNAPSHOT" {
			t.Fatal("metadata snapshot changed")
		}
		if piece.ID == score.ID {
			saved++
			if piece.ReaderState == nil || piece.ReaderState.Mode != "scroll" || piece.ReaderState.LastPage != 2 || piece.ReaderState.Zoom != 1.5 || piece.ReaderState.ScrollPaused || !piece.Favorite || piece.Notes != "=private note" || piece.Opus != "Op. 10" || piece.MusicKey != "C♯ minor" || piece.PDF.ChecksumSHA256 != old.Checksum || !bytes.Equal(files[piece.PDF.Path], original) {
				t.Fatalf("snapshot data mismatch: %+v", piece)
			}
		} else if piece.PDF != nil || piece.ReaderState != nil {
			t.Fatal("metadata-only state synthesized")
		}
	}
	for _, status := range []string{StatusLearning, StatusPlaying, StatusShelved} {
		if counts[status] == 0 {
			t.Fatal("status omitted", status)
		}
	}
	if saved != 1 || len(files) != 3 || bytes.Contains(files["pieces.csv"], []byte("CHANGED AFTER SNAPSHOT")) || bytes.Contains(files["library.json"], []byte(old.Key)) {
		t.Fatal("snapshot/privacy mismatch")
	}
	// The public service path also owns and releases its transaction and limiter.
	var otherOutput bytes.Buffer
	if err := s.ExportLibrary(ctx, other, &otherOutput); err != nil {
		t.Fatal(err)
	}
	otherFiles := readExportZIP(t, otherOutput.Bytes())
	if bytes.Contains(otherFiles["library.json"], []byte(score.ID)) || len(otherFiles) != 3 {
		t.Fatal("cross-owner export")
	}
	if s.pool.Stat().AcquiredConns() != 0 {
		t.Fatal("export connection leaked")
	}
}

func TestIntegrationLibraryExportConcurrentDeleteAbortsAndReleases(t *testing.T) {
	ctx, s, owner, _ := exportIntegrationSetup(t)
	piece, object := exportIntegrationPDF(t, ctx, s, owner, []byte("original"))
	var output bytes.Buffer
	writer := &exportHookWriter{Writer: &output, hook: func() error {
		if _, err := s.pool.Exec(ctx, `DELETE FROM pieces WHERE id=$1 AND user_id=$2`, piece.ID, owner); err != nil {
			return err
		}
		return s.store.Delete(ctx, object.Key)
	}}
	if err := s.ExportLibrary(ctx, owner, writer); err == nil {
		t.Fatal("deleted PDF silently omitted")
	}
	if _, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len())); err == nil {
		t.Fatal("deleted-file export finalized")
	}
	if s.pool.Stat().AcquiredConns() != 0 {
		t.Fatal("snapshot connection leaked")
	}
	s.exports.mu.Lock()
	active := s.exports.users[owner].active
	s.exports.mu.Unlock()
	if active {
		t.Fatal("export slot leaked")
	}
}
