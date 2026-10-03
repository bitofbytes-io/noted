package app

import (
	"bytes"
	"context"
	"testing"
)

// preparePDF gives a piece a new PDF the way Prepare does: a draft for the
// piece whose pages all come from data, saved with data as the output.
func preparePDF(ctx context.Context, s *Service, owner, pieceID, filename string, data []byte) (Piece, error) {
	d, err := s.CreateImport(ctx, owner, CreateImport{PieceID: pieceID})
	if err != nil {
		return Piece{}, err
	}
	previous := map[string]bool{}
	for _, source := range d.Sources {
		previous[source.ID] = true
	}
	if d, err = s.UploadImportSource(ctx, owner, d.ID, filename, d.Revision, bytes.NewReader(data)); err != nil {
		return Piece{}, err
	}
	manifest := d.Manifest
	manifest.Pages = []PageEdit{}
	for _, page := range d.Manifest.Pages {
		if !previous[page.SourceID] {
			manifest.Pages = append(manifest.Pages, page)
		}
	}
	if d, err = s.UpdateImport(ctx, owner, d.ID, UpdateImport{
		Revision: d.Revision, Metadata: d.Metadata, IMSLPAutoFill: d.IMSLPAutoFill, Manifest: manifest,
	}); err != nil {
		return Piece{}, err
	}
	return s.FinalizeImport(ctx, owner, d.ID, d.Revision, bytes.NewReader(data))
}

// storeLegacyPDF attaches data as a piece's PDF without a preparation
// manifest, as the removed direct upload did. Such pieces still exist, and
// this is the only way to store a PDF longer than MaxPreparedPages.
func storeLegacyPDF(t *testing.T, ctx context.Context, s *Service, pieceID, filename string, data []byte) {
	t.Helper()
	_, pages, _, _, err := ValidateImportBytes(data)
	if err != nil {
		t.Fatal(err)
	}
	object, err := s.store.Save(ctx, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `
		INSERT INTO piece_pdfs(piece_id,storage_key,original_filename,size_bytes,checksum_sha256,page_count)
		VALUES($1,$2,$3,$4,$5,$6)`,
		pieceID, object.Key, filename, object.Size, object.Checksum, pages); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE pieces SET content_revision=content_revision+1 WHERE id=$1`, pieceID); err != nil {
		t.Fatal(err)
	}
}
