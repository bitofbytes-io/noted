package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// finalizeTarget is the piece a draft is saved to and what it held before.
type finalizeTarget struct {
	pieceID  string
	metadata PieceInput
	// Zero when the piece is new or has no PDF yet.
	oldKey, oldChecksum string
	oldPageCount        int
}

func (s *Service) FinalizeImport(ctx context.Context, owner, id string, revision int64, reader io.Reader) (FinalizeResult, error) {
	tx, err := s.importTx(ctx, owner)
	if err != nil {
		return FinalizeResult{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
	d, err := s.draftTx(ctx, tx, owner, id)
	if err != nil {
		return FinalizeResult{}, err
	}
	if d.Revision != revision {
		return FinalizeResult{}, ErrConflict
	}
	if d.Finalized && d.PieceID != nil {
		return finalizedPiece(ctx, tx, owner, *d.PieceID)
	}
	metadata, data, count, err := s.validateFinalize(d, reader)
	if err != nil {
		return FinalizeResult{}, err
	}
	target, err := lockFinalizeTarget(ctx, tx, owner, d, metadata)
	if err != nil {
		return FinalizeResult{}, err
	}
	if data, err = s.unchangedPDF(ctx, d, target, data, count); err != nil {
		return FinalizeResult{}, err
	}
	object, err := s.store.Save(ctx, bytes.NewReader(data))
	if err != nil {
		return FinalizeResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			cleanupCtx := context.WithoutCancel(ctx)
			_ = tx.Rollback(cleanupCtx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
			s.queueObject(cleanupCtx, object.Key)
		}
	}()
	if err = writePiece(ctx, tx, d, target, object, count); err != nil {
		return FinalizeResult{}, err
	}
	if err = recordFinalized(ctx, tx, d, target, object); err != nil {
		return FinalizeResult{}, err
	}
	result, err := finalizedPiece(ctx, tx, owner, target.pieceID)
	if err != nil {
		return FinalizeResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FinalizeResult{}, err
	}
	committed = true
	return result, nil
}

// validateFinalize checks the draft and the prepared PDF read from reader. It
// returns the validated metadata, the PDF bytes and their page count.
func (s *Service) validateFinalize(d ImportDraft, reader io.Reader) (PieceInput, []byte, int, error) {
	if err := validateManifest(d.Manifest, d.Sources, false); err != nil {
		return PieceInput{}, nil, 0, err
	}
	metadata, err := validatePiece(d.Metadata)
	if err != nil {
		return PieceInput{}, nil, 0, err
	}
	data, err := io.ReadAll(io.LimitReader(reader, s.importLimit()+1))
	if err != nil {
		return PieceInput{}, nil, 0, err
	}
	if int64(len(data)) > s.importLimit() {
		return PieceInput{}, nil, 0, ErrImportLimit
	}
	mime, count, _, _, err := ValidateImportBytes(data)
	if err != nil {
		return PieceInput{}, nil, 0, err
	}
	if mime != "application/pdf" || count != len(d.Manifest.Pages) {
		return PieceInput{}, nil, 0, invalid("output PDF must have exactly the prepared page count")
	}
	return metadata, data, count, nil
}

// lockFinalizeTarget locks the piece being replaced and checks the draft is still
// current, or inserts the new piece. The returned metadata is what gets saved.
func lockFinalizeTarget(ctx context.Context, tx pgx.Tx, owner string, d ImportDraft, metadata PieceInput) (finalizeTarget, error) {
	if d.PieceID == nil {
		newID := uuid.NewString()
		_, err := tx.Exec(ctx, `INSERT INTO pieces(id,user_id,title) VALUES($1,$2,$3)`, newID, owner, metadata.Title)
		return finalizeTarget{pieceID: newID, metadata: metadata}, err
	}
	target := finalizeTarget{pieceID: *d.PieceID}
	var rev int64
	var current PieceInput
	// Details-only aliases and musical metadata always keep their current saved values.
	var aliases, opus, musicKey string
	err := tx.QueryRow(ctx, `SELECT content_revision,title,composer,favorite,source_url,listening_url,notes,aliases,opus,music_key FROM pieces WHERE id=$1 AND user_id=$2 FOR UPDATE`, *d.PieceID, owner).Scan(&rev, &current.Title, &current.Composer, &current.Favorite, &current.SourceURL, &current.ListeningURL, &current.Notes, &aliases, &opus, &musicKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return target, ErrNotFound
	}
	if err != nil {
		return target, err
	}
	// Only content changes (a new PDF or preparation) invalidate the draft.
	if rev != d.BaseRevision {
		return target, ErrPieceChanged
	}
	if d.BaseMetadata != nil {
		if metadata, err = validatePiece(mergeDraftMetadata(current, *d.BaseMetadata, metadata)); err != nil {
			return target, err
		}
	} else if metadata != current {
		// A draft created before its base was recorded cannot tell its own edits
		// from newer piece edits, so it must not overwrite either; it is retained.
		return target, ErrPieceChanged
	}
	metadata.Aliases = aliases
	metadata.Opus, metadata.MusicKey = opus, musicKey
	target.metadata = metadata
	err = tx.QueryRow(ctx, `SELECT storage_key,checksum_sha256,page_count FROM piece_pdfs WHERE piece_id=$1`, *d.PieceID).Scan(&target.oldKey, &target.oldChecksum, &target.oldPageCount)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return target, err
	}
	return target, nil
}

// unchangedPDF returns the saved PDF's own bytes when the draft made no edits, so
// finalizing keeps the original file; otherwise it returns data as given.
func (s *Service) unchangedPDF(ctx context.Context, d ImportDraft, target finalizeTarget, data []byte, count int) ([]byte, error) {
	if target.oldKey == "" || target.oldPageCount != count {
		return data, nil
	}
	manifest, err := json.Marshal(d.Manifest)
	if err != nil {
		return nil, err
	}
	initial, err := json.Marshal(d.InitialManifest)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(manifest, initial) {
		return data, nil
	}
	original, err := s.store.Open(ctx, target.oldKey)
	if err != nil {
		return nil, err
	}
	data, err = io.ReadAll(original)
	_ = original.Close() //nolint:errcheck // Read-only stream; the read/response result is handled separately.
	return data, err
}

// writePiece saves the metadata, the new PDF and its source links, and resets the
// reader's place when the PDF changed.
func writePiece(ctx context.Context, tx pgx.Tx, d ImportDraft, target finalizeTarget, object assets.Object, count int) error {
	metadata := target.metadata
	manifest, err := json.Marshal(d.Manifest)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE pieces SET title=$2,composer=$3,favorite=$4,source_url=$5,listening_url=$6,notes=$7,preparation_manifest=$8,search_text=$9,composer_sort=$10,composer_sort_source=$3,composer_sort_version=$11,content_revision=content_revision+1,updated_at=now() WHERE id=$1`, target.pieceID, metadata.Title, metadata.Composer, metadata.Favorite, metadata.SourceURL, metadata.ListeningURL, metadata.Notes, manifest, searchText(metadata), composerSortKey(metadata.Composer), composerKeyVersion)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO piece_pdfs(piece_id,storage_key,original_filename,size_bytes,checksum_sha256,page_count) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(piece_id) DO UPDATE SET storage_key=excluded.storage_key,original_filename=excluded.original_filename,size_bytes=excluded.size_bytes,checksum_sha256=excluded.checksum_sha256,page_count=excluded.page_count,uploaded_at=now()`, target.pieceID, object.Key, metadata.Title+".pdf", object.Size, object.Checksum, count)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM piece_sources WHERE piece_id=$1`, target.pieceID); err != nil {
		return err
	}
	for _, p := range d.Manifest.Pages {
		if _, err = tx.Exec(ctx, `INSERT INTO piece_sources VALUES($1,$2) ON CONFLICT DO NOTHING`, target.pieceID, p.SourceID); err != nil {
			return err
		}
	}
	if target.oldChecksum != object.Checksum {
		// The place resets, but updated_at stays: it is the piece's last play
		// (Recently played, Fresh, Continue), and a new PDF is not a play.
		if _, err = tx.Exec(ctx, `UPDATE reader_states SET last_page=1,scroll_position=0,zoom=1,scroll_paused=true WHERE piece_id=$1`, target.pieceID); err != nil {
			return err
		}
	}
	return nil
}

// recordFinalized marks the draft saved and queues the files nothing references
// any more, including the PDF the piece just replaced.
func recordFinalized(ctx context.Context, tx pgx.Tx, d ImportDraft, target finalizeTarget, object assets.Object) error {
	if _, err := tx.Exec(ctx, `UPDATE import_drafts SET finalized=true,piece_id=$2,updated_at=now() WHERE id=$1`, d.ID, target.pieceID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM draft_sources WHERE draft_id=$1`, d.ID); err != nil {
		return err
	}
	if err := collectOrphans(ctx, tx); err != nil {
		return err
	}
	if target.oldKey != "" {
		return queueKey(ctx, tx, target.oldKey)
	}
	return nil
}

// mergeDraftMetadata applies only the fields a draft changed from its base to the
// current piece, so metadata edited elsewhere while the draft was open is kept.
func mergeDraftMetadata(current, base, draft PieceInput) PieceInput {
	pick := func(current, base, draft string) string {
		if draft != base {
			return draft
		}
		return current
	}
	merged := PieceInput{
		Title:        pick(current.Title, base.Title, draft.Title),
		Composer:     pick(current.Composer, base.Composer, draft.Composer),
		Favorite:     current.Favorite,
		SourceURL:    pick(current.SourceURL, base.SourceURL, draft.SourceURL),
		ListeningURL: pick(current.ListeningURL, base.ListeningURL, draft.ListeningURL),
		Notes:        pick(current.Notes, base.Notes, draft.Notes),
	}
	if draft.Favorite != base.Favorite {
		merged.Favorite = draft.Favorite
	}
	return merged
}

// Resolve the saved checksum, including the original-byte preservation path,
// inside the finalization transaction. Retries use current owned rows rather
// than persisting a warning that could outlive its matching piece.
func finalizedPiece(ctx context.Context, tx pgx.Tx, owner, id string) (FinalizeResult, error) {
	piece, err := scanPiece(tx.QueryRow(ctx, `SELECT `+pieceColumns+` FROM `+pieceTables+`
		WHERE p.id=$1 AND p.user_id=$2`, id, owner))
	if errors.Is(err, pgx.ErrNoRows) {
		return FinalizeResult{}, ErrNotFound
	}
	if err != nil {
		return FinalizeResult{}, err
	}
	result := FinalizeResult{Piece: piece}
	if piece.PDF == nil {
		return result, nil
	}
	var duplicate DuplicatePiece
	err = tx.QueryRow(ctx, `SELECT p.id,p.title FROM piece_pdfs f JOIN pieces p ON p.id=f.piece_id
		WHERE p.user_id=$1 AND f.checksum_sha256=$2 AND p.id<>$3
		ORDER BY p.id LIMIT 1`, owner, piece.PDF.ChecksumSHA256, id).Scan(&duplicate.ID, &duplicate.Title)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return FinalizeResult{}, err
	}
	result.DuplicateOf = &duplicate
	return result, nil
}
