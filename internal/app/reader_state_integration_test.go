package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationPDFReplacementAndReaderStateChecksum(t *testing.T) {
	databaseURL := os.Getenv("NOTED_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store, err := assets.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, store)
	ownerID := uuid.NewString()
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,email,display_name,auth_provider) VALUES($1,$2,'Reader tester','development')`, ownerID, fmt.Sprintf("reader-%s@example.test", ownerID)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, ownerID)
	})
	piece, err := service.CreatePiece(ctx, ownerID, PieceInput{Title: "Replacement test"})
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile("../../testdata/fixtures/noted-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}
	changed := append(append([]byte(nil), original...), []byte("\n% changed replacement\n")...)
	failedReplacement := append(append([]byte(nil), original...), []byte("\n% failed replacement\n")...)

	piece, err = service.UploadPDF(ctx, ownerID, piece.ID, "score.pdf", 2, bytes.NewReader(original))
	if err != nil {
		t.Fatal(err)
	}
	originalChecksum := piece.PDF.ChecksumSHA256
	saved, err := service.PutReaderState(ctx, ownerID, piece.ID, ReaderState{
		PDFChecksumSHA256: originalChecksum,
		Mode:              "scroll",
		LastPage:          2,
		ScrollPosition:    321.5,
		Zoom:              1.7,
		ScrollSpeed:       8,
		ScrollPaused:      false,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Replacing a PDF with identical bytes must not disturb any reader setting.
	piece, err = service.UploadPDF(ctx, ownerID, piece.ID, "renamed.pdf", 2, bytes.NewReader(original))
	if err != nil {
		t.Fatal(err)
	}
	identical, err := service.GetReaderState(ctx, ownerID, piece.ID)
	if err != nil {
		t.Fatal(err)
	}
	if piece.PDF.ChecksumSHA256 != originalChecksum ||
		identical.Mode != saved.Mode || identical.LastPage != saved.LastPage ||
		identical.ScrollPosition != saved.ScrollPosition || identical.Zoom != saved.Zoom ||
		identical.ScrollSpeed != saved.ScrollSpeed || identical.ScrollPaused != saved.ScrollPaused ||
		!identical.UpdatedAt.Equal(saved.UpdatedAt) {
		t.Fatalf("identical replacement changed reader state: before=%+v after=%+v piece=%+v", saved, identical, piece.PDF)
	}

	// Different bytes reset position/page/zoom/pause while preserving mode and speed.
	piece, err = service.UploadPDF(ctx, ownerID, piece.ID, "changed.pdf", 2, bytes.NewReader(changed))
	if err != nil {
		t.Fatal(err)
	}
	changedChecksum := piece.PDF.ChecksumSHA256
	if changedChecksum == originalChecksum {
		t.Fatal("changed PDF retained the original checksum")
	}
	reset, err := service.GetReaderState(ctx, ownerID, piece.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reset.PDFChecksumSHA256 != changedChecksum || reset.Mode != "scroll" ||
		reset.LastPage != 1 || reset.ScrollPosition != 0 || reset.Zoom != 1 ||
		reset.ScrollSpeed != 8 || !reset.ScrollPaused {
		t.Fatalf("changed replacement did not reset only positional state: %+v", reset)
	}

	current, err := service.PutReaderState(ctx, ownerID, piece.ID, ReaderState{
		PDFChecksumSHA256: changedChecksum,
		Mode:              "page",
		LastPage:          2,
		ScrollPosition:    75,
		Zoom:              1.4,
		ScrollSpeed:       6,
		ScrollPaused:      false,
	})
	if err != nil {
		t.Fatal(err)
	}
	stale := current
	stale.PDFChecksumSHA256 = originalChecksum
	stale.LastPage = 1
	stale.Zoom = 2
	if _, err = service.PutReaderState(ctx, ownerID, piece.ID, stale); !errors.Is(err, ErrPDFChanged) {
		t.Fatalf("stale reader save error = %v, want ErrPDFChanged", err)
	}
	afterStale, err := service.GetReaderState(ctx, ownerID, piece.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterStale.PDFChecksumSHA256 != changedChecksum || afterStale.Mode != current.Mode ||
		afterStale.LastPage != current.LastPage || afterStale.ScrollPosition != current.ScrollPosition ||
		afterStale.Zoom != current.Zoom || afterStale.ScrollSpeed != current.ScrollSpeed ||
		afterStale.ScrollPaused != current.ScrollPaused || !afterStale.UpdatedAt.Equal(current.UpdatedAt) {
		t.Fatalf("stale reader save mutated current state: before=%+v after=%+v", current, afterStale)
	}

	// Force the reset statement to fail after the replacement has begun. The
	// transaction must retain both the current PDF and all reader settings.
	if _, err = pool.Exec(ctx, `
		CREATE FUNCTION noted_test_fail_reader_reset() RETURNS trigger
		LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced reader reset failure'; END $$;
		CREATE TRIGGER noted_test_fail_reader_reset
		BEFORE UPDATE ON reader_states FOR EACH ROW
		EXECUTE FUNCTION noted_test_fail_reader_reset()`); err != nil {
		t.Fatal(err)
	}
	_, replaceErr := service.UploadPDF(ctx, ownerID, piece.ID, "failed.pdf", 2, bytes.NewReader(failedReplacement))
	if _, err = pool.Exec(ctx, `
		DROP TRIGGER noted_test_fail_reader_reset ON reader_states;
		DROP FUNCTION noted_test_fail_reader_reset()`); err != nil {
		t.Fatal(err)
	}
	if replaceErr == nil {
		t.Fatal("replacement unexpectedly succeeded despite reset failure")
	}
	afterFailurePiece, err := service.GetPiece(ctx, ownerID, piece.ID)
	if err != nil {
		t.Fatal(err)
	}
	afterFailureState, err := service.GetReaderState(ctx, ownerID, piece.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterFailurePiece.PDF.ChecksumSHA256 != changedChecksum ||
		afterFailurePiece.PDF.OriginalFilename != "changed.pdf" ||
		afterFailureState.PDFChecksumSHA256 != changedChecksum || afterFailureState.Mode != current.Mode ||
		afterFailureState.LastPage != current.LastPage || afterFailureState.ScrollPosition != current.ScrollPosition ||
		afterFailureState.Zoom != current.Zoom || afterFailureState.ScrollSpeed != current.ScrollSpeed ||
		afterFailureState.ScrollPaused != current.ScrollPaused || !afterFailureState.UpdatedAt.Equal(current.UpdatedAt) {
		t.Fatalf("failed replacement partially committed: piece=%+v state=%+v", afterFailurePiece.PDF, afterFailureState)
	}
}
