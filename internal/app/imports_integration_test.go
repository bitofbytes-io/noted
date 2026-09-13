package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"io"
	"os"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/assets"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationImports(t *testing.T) {
	url := os.Getenv("NOTED_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancelTest := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelTest()
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store, err := assets.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := NewService(pool, store)
	owner := User{ID: uuid.NewString()}
	other := User{ID: uuid.NewString()}
	for i, u := range []User{owner, other} {
		if _, err = pool.Exec(ctx, `INSERT INTO users(id,email,display_name,auth_provider) VALUES($1,$2,'Intake tester','development')`, u.ID, fmt.Sprintf("intake-%d-%s@example.test", i, u.ID)); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id=ANY($1::uuid[])`, []string{owner.ID, other.ID})
	})
	pdf, err := os.ReadFile("../../testdata/fixtures/noted-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}
	d, err := s.CreateImport(ctx, owner.ID, CreateImport{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.GetImport(ctx, other.ID, d.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign draft: %v", err)
	}
	d, err = s.UploadImportSource(ctx, owner.ID, d.ID, "score.pdf", d.Revision, bytes.NewReader(pdf))
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Manifest.Pages) != 2 || d.Sources[0].PageCount != 2 {
		t.Fatalf("actual count %+v", d)
	}
	if _, _, err = s.ImportSource(ctx, other.ID, d.ID, d.Sources[0].ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign source: %v", err)
	}
	if _, err = s.UpdateImport(ctx, other.ID, d.ID, UpdateImport{Revision: d.Revision, Manifest: d.Manifest}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign patch: %v", err)
	}
	if _, err = s.UploadImportSource(ctx, other.ID, d.ID, "score.pdf", d.Revision, bytes.NewReader(pdf)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign upload: %v", err)
	}
	if _, err = s.FinalizeImport(ctx, other.ID, d.ID, d.Revision, bytes.NewReader(pdf)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign finalize: %v", err)
	}
	if err = s.DeleteImport(ctx, other.ID, d.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign delete: %v", err)
	}
	if _, err = s.UpdateImport(ctx, owner.ID, d.ID, UpdateImport{Revision: d.Revision - 1, Manifest: d.Manifest}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale patch: %v", err)
	}
	piece, err := s.FinalizeImport(ctx, owner.ID, d.ID, d.Revision, bytes.NewReader(pdf))
	if err != nil {
		t.Fatal(err)
	}
	retry, err := s.FinalizeImport(ctx, owner.ID, d.ID, d.Revision, bytes.NewReader(nil))
	if err != nil || retry.ID != piece.ID {
		t.Fatalf("finalize retry: %v %+v", err, retry)
	}
	_, reader, err := s.PDFSource(ctx, owner.ID, piece.ID)
	if err != nil {
		t.Fatal(err)
	}
	actual, _ := io.ReadAll(reader)
	reader.Close()
	if !bytes.Equal(actual, pdf) {
		t.Fatal("no-op changed PDF bytes")
	}
	state := ReaderState{Mode: "scroll", LastPage: 2, Zoom: 1.5, ScrollPosition: 10, ScrollSpeed: 44, ScrollPaused: true}
	if _, err = s.PutReaderState(ctx, owner.ID, piece.ID, state); err != nil {
		t.Fatal(err)
	}
	first, err := s.CreateImport(ctx, owner.ID, CreateImport{PieceID: piece.ID})
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateImport(ctx, owner.ID, CreateImport{PieceID: piece.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.FinalizeImport(ctx, owner.ID, first.ID, first.Revision, bytes.NewReader(pdf)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.FinalizeImport(ctx, owner.ID, second.ID, second.Revision, bytes.NewReader(pdf)); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale piece publish: %v", err)
	}
	retained, err := s.GetReaderState(ctx, owner.ID, piece.ID)
	if err != nil || retained.LastPage != 2 || retained.Zoom != 1.5 {
		t.Fatalf("no-op reader state %+v %v", retained, err)
	}
	if err = s.DeleteImport(ctx, owner.ID, second.ID); err != nil {
		t.Fatal(err)
	}
	expired, err := s.CreateImport(ctx, owner.ID, CreateImport{})
	if err != nil {
		t.Fatal(err)
	}
	expired, err = s.UploadImportSource(ctx, owner.ID, expired.ID, "score.pdf", expired.Revision, bytes.NewReader(pdf))
	if err != nil {
		t.Fatal(err)
	}
	key := expired.Sources[0].StorageKey
	_, err = pool.Exec(ctx, `UPDATE import_drafts SET updated_at=now()-interval '8 days' WHERE id=$1`, expired.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.CleanupImports(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = s.GetImport(ctx, owner.ID, expired.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired draft: %v", err)
	}
	if r, err := store.Open(ctx, key); err == nil {
		r.Close()
		t.Fatal("expired source not removed")
	}
	// Failed writes must release the sole pool connection before queueing files.
	for _, finalize := range []bool{false, true} {
		failedDraft, err := s.CreateImport(ctx, owner.ID, CreateImport{})
		if err != nil {
			t.Fatal(err)
		}
		if finalize {
			failedDraft, err = s.UploadImportSource(ctx, owner.ID, failedDraft.ID, "failure.pdf", failedDraft.Revision, bytes.NewReader(pdf))
			if err != nil {
				t.Fatal(err)
			}
		}
		operationCtx, cancel := context.WithCancel(ctx)
		interruptedStore := &cancelAfterSaveStore{Store: store, cancel: cancel}
		interrupted := NewService(pool, interruptedStore)
		done := make(chan error, 1)
		go func() {
			if finalize {
				_, err := interrupted.FinalizeImport(operationCtx, owner.ID, failedDraft.ID, failedDraft.Revision, bytes.NewReader(pdf))
				done <- err
			} else {
				_, err := interrupted.UploadImportSource(operationCtx, owner.ID, failedDraft.ID, "failure.pdf", failedDraft.Revision, bytes.NewReader(pdf))
				done <- err
			}
		}()
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("expected interrupted write")
			}
		case <-time.After(3 * time.Second):
			t.Fatal("write cleanup blocked on the sole pool connection")
		}
		var queued bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM asset_deletion_queue WHERE storage_key=$1)`, interruptedStore.key).Scan(&queued); err != nil || !queued {
			t.Fatalf("failed write not queued: %v %v", queued, err)
		}
		cancel()
		if err := s.DeleteImport(ctx, owner.ID, failedDraft.ID); err != nil {
			t.Fatal(err)
		}
	}
	retryDraft, err := s.CreateImport(ctx, owner.ID, CreateImport{})
	if err != nil {
		t.Fatal(err)
	}
	retryDraft, err = s.UploadImportSource(ctx, owner.ID, retryDraft.ID, "retry.pdf", retryDraft.Revision, bytes.NewReader(pdf))
	if err != nil {
		t.Fatal(err)
	}
	retryKey := retryDraft.Sources[0].StorageKey
	if err = s.DeleteImport(ctx, owner.ID, retryDraft.ID); err != nil {
		t.Fatal(err)
	}
	unreliable := NewService(pool, &failingDeleteStore{Store: store, failures: 100})
	if err = unreliable.CleanupImports(ctx); err != nil {
		t.Fatal(err)
	}
	var attempts int
	if err = pool.QueryRow(ctx, `SELECT attempts FROM asset_deletion_queue WHERE storage_key=$1`, retryKey).Scan(&attempts); err != nil || attempts < 1 {
		t.Fatalf("durable retry missing %d %v", attempts, err)
	}
	if err = s.CleanupImports(ctx); err != nil {
		t.Fatal(err)
	}
	if r, err := store.Open(ctx, retryKey); err == nil {
		r.Close()
		t.Fatal("retried delete still present")
	}
	if err = s.DeletePiece(ctx, owner.ID, piece.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.CleanupImports(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM import_assets WHERE user_id=$1`, owner.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("orphan assets: %d %v", count, err)
	}
}
func TestImportValidation(t *testing.T) {
	pdf, err := os.ReadFile("../../testdata/fixtures/noted-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}
	mime, count, _, _, err := ValidateImportBytes(pdf)
	if err != nil || mime != "application/pdf" || count != 2 {
		t.Fatalf("parser: %s %d %v", mime, count, err)
	}
	for _, data := range [][]byte{[]byte("%PDF-fake"), []byte("hello"), pdf[:100]} {
		if _, _, _, _, err = ValidateImportBytes(data); err == nil {
			t.Fatal("malformed source accepted")
		}
	}
	malformed, err := os.ReadFile("../../testdata/fixtures/noted-ccitt-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err = ValidateImportBytes(malformed); err == nil {
		t.Fatal("truncated CCITT strips accepted")
	}
	for _, link := range []string{"http://imslp.org/wiki/x", "https://imslp.org.evil.test/wiki/x", "https://user@imslp.org/wiki/x", "https://imslp.org:443/wiki/x"} {
		if ValidateIMSLP(link) == nil {
			t.Fatal("invalid IMSLP URL accepted")
		}
	}
}

type cancelAfterSaveStore struct {
	assets.Store
	cancel context.CancelFunc
	key    string
}

func (s *cancelAfterSaveStore) Save(ctx context.Context, r io.Reader) (assets.Object, error) {
	o, e := s.Store.Save(ctx, r)
	if e == nil {
		s.key = o.Key
		s.cancel()
	}
	return o, e
}
