package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationDuplicateFinalize(t *testing.T) {
	dsn := os.Getenv("NOTED_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store, err := assets.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, store)
	owner, other := uuid.NewString(), uuid.NewString()
	for _, id := range []string{owner, other} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,display_name,auth_provider)
			VALUES($1,$2,'Duplicate tester','development')`, id, id+"@example.test"); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for _, query := range []string{
			`DELETE FROM import_drafts WHERE user_id=ANY($1::uuid[])`,
			`DELETE FROM pieces WHERE user_id=ANY($1::uuid[])`,
			`DELETE FROM users WHERE id=ANY($1::uuid[])`,
		} {
			if _, err := pool.Exec(context.Background(), query, []string{owner, other}); err != nil {
				t.Error(err)
			}
		}
	}()
	pdf, err := os.ReadFile("../../testdata/fixtures/noted-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}
	newDraft := func(user, title string) ImportDraft {
		t.Helper()
		d, err := service.CreateImport(ctx, user, CreateImport{})
		if err != nil {
			t.Fatal(err)
		}
		d, err = service.UploadImportSource(ctx, user, d.ID, title+".pdf", d.Revision, bytes.NewReader(pdf))
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	finalize := func(user string, d ImportDraft) FinalizeResult {
		t.Helper()
		result, err := service.FinalizeImport(ctx, user, d.ID, d.Revision, bytes.NewReader(pdf))
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	foreign := finalize(other, newDraft(other, "Other owner's private title"))
	firstDraft := newDraft(owner, "First edition")
	first := finalize(owner, firstDraft)
	if foreign.DuplicateOf != nil || first.DuplicateOf != nil {
		t.Fatal("other-owner or self match leaked")
	}
	// Same-target editing uses the final saved checksum: the unchanged manifest
	// preserves original bytes even if the submitted valid PDF has extra bytes.
	edit, err := service.CreateImport(ctx, owner, CreateImport{PieceID: first.ID})
	if err != nil {
		t.Fatal(err)
	}
	rewritten := append(bytes.Clone(pdf), []byte("\n% synthetic different serialization\n")...)
	unchanged, err := service.FinalizeImport(ctx, owner, edit.ID, edit.Revision, bytes.NewReader(rewritten))
	if err != nil || unchanged.DuplicateOf != nil || unchanged.PDF.ChecksumSHA256 != first.PDF.ChecksumSHA256 {
		t.Fatalf("same target/original checksum: %+v %v", unchanged, err)
	}

	secondDraft := newDraft(owner, "Second edition")
	second := finalize(owner, secondDraft)
	if second.ID == first.ID || second.DuplicateOf == nil || *second.DuplicateOf != (DuplicatePiece{ID: first.ID, Title: first.Title}) {
		t.Fatalf("missing advisory duplicate: %+v", second.DuplicateOf)
	}
	edit, err = service.CreateImport(ctx, owner, CreateImport{PieceID: first.ID})
	if err != nil {
		t.Fatal(err)
	}
	preserved, err := service.FinalizeImport(ctx, owner, edit.ID, edit.Revision, bytes.NewReader(rewritten))
	if err != nil || preserved.DuplicateOf == nil || preserved.DuplicateOf.ID != second.ID ||
		preserved.PDF.ChecksumSHA256 != first.PDF.ChecksumSHA256 {
		t.Fatal("warning used submitted bytes instead of the preserved saved PDF", err)
	}
	for _, piece := range []FinalizeResult{first, second} {
		_, reader, err := service.PDFSource(ctx, owner, piece.ID)
		if err != nil {
			t.Fatal(err)
		}
		data, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil || !bytes.Equal(data, pdf) {
			t.Fatal("copies not independently readable", readErr, closeErr)
		}
	}
	encoded, err := json.Marshal(second)
	if err != nil {
		t.Fatal(err)
	}
	var legacy Piece
	if err := json.Unmarshal(encoded, &legacy); err != nil || legacy.ID != second.ID || legacy.PDF == nil {
		t.Fatal("top-level piece JSON changed", err)
	}
	plain, err := json.Marshal(second.Piece)
	if err != nil || bytes.Contains(plain, []byte("duplicateOf")) {
		t.Fatal("warning leaked into ordinary piece shape", err)
	}

	third := finalize(owner, newDraft(owner, "Third edition"))
	ids := []string{first.ID, second.ID}
	sort.Strings(ids)
	if third.DuplicateOf == nil || third.DuplicateOf.ID != ids[0] {
		t.Fatal("matching piece selection is not deterministic")
	}
	var beforeRevision int64
	var beforeKey string
	if err := pool.QueryRow(ctx, `SELECT p.content_revision,f.storage_key FROM pieces p JOIN piece_pdfs f ON f.piece_id=p.id WHERE p.id=$1`, second.ID).Scan(&beforeRevision, &beforeKey); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE pieces SET title='Renamed current edition' WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.DeletePiece(ctx, owner, third.ID); err != nil {
		t.Fatal(err)
	}
	retry, err := service.FinalizeImport(ctx, owner, secondDraft.ID, secondDraft.Revision, unreadDuplicateBody{})
	if err != nil || retry.ID != second.ID || retry.DuplicateOf == nil || retry.DuplicateOf.Title != "Renamed current edition" {
		t.Fatalf("retry did not resolve current owned title: %+v %v", retry.DuplicateOf, err)
	}
	var afterRevision int64
	var afterKey string
	if err := pool.QueryRow(ctx, `SELECT p.content_revision,f.storage_key FROM pieces p JOIN piece_pdfs f ON f.piece_id=p.id WHERE p.id=$1`, second.ID).Scan(&afterRevision, &afterKey); err != nil {
		t.Fatal(err)
	}
	if beforeRevision != afterRevision || beforeKey != afterKey {
		t.Fatal("retry changed the saved piece or object")
	}
	if _, err := service.FinalizeImport(ctx, other, secondDraft.ID, secondDraft.Revision, unreadDuplicateBody{}); !errors.Is(err, ErrNotFound) {
		t.Fatal("other owner finalized draft", err)
	}

	failedDraft := newDraft(owner, "Interrupted duplicate")
	failedCtx, stop := context.WithCancel(ctx)
	interrupted := NewService(pool, &cancelAfterSaveStore{Store: store, cancel: stop})
	failed, err := interrupted.FinalizeImport(failedCtx, owner, failedDraft.ID, failedDraft.Revision, bytes.NewReader(pdf))
	stop()
	if err == nil || failed.ID != "" || failed.DuplicateOf != nil {
		t.Fatal("failed transaction returned successful duplicate result")
	}
	retained, err := service.GetImport(ctx, owner, failedDraft.ID)
	if err != nil || retained.Finalized || retained.PieceID != nil {
		t.Fatal("failed finalize changed draft", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pieces WHERE user_id=$1`, owner).Scan(&count); err != nil || count != 2 {
		t.Fatal("failed finalize created another piece", count, err)
	}
	if err := service.DeletePiece(ctx, owner, first.ID); err != nil {
		t.Fatal(err)
	}
	retry, err = service.FinalizeImport(ctx, owner, secondDraft.ID, secondDraft.Revision, unreadDuplicateBody{})
	if err != nil || retry.DuplicateOf != nil {
		t.Fatal("deleted/other-owner match remained in retry", err)
	}
	if err := service.DeletePiece(ctx, owner, second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.FinalizeImport(ctx, owner, secondDraft.ID, secondDraft.Revision, unreadDuplicateBody{}); !errors.Is(err, ErrNotFound) {
		t.Fatal("deleted finalized target returned", err)
	}
}

type unreadDuplicateBody struct{}

func (unreadDuplicateBody) Read([]byte) (int, error) {
	return 0, errors.New("a finalized retry must not read the submitted PDF")
}
