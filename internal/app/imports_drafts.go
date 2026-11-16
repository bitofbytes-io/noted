package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const draftColumns = `id,piece_id,base_revision,revision,metadata,manifest,initial_manifest,finalized,updated_at`

func scanDraft(row pgx.Row) (ImportDraft, error) {
	var d ImportDraft
	var metadata, manifest, initial []byte
	err := row.Scan(&d.ID, &d.PieceID, &d.BaseRevision, &d.Revision, &metadata, &manifest, &initial, &d.Finalized, &d.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, ErrNotFound
	}
	if err != nil {
		return d, err
	}
	if err = json.Unmarshal(metadata, &d.Metadata); err != nil {
		return d, err
	}
	var draftOnly struct {
		IMSLPAutoFill IMSLPAutoFill `json:"imslpAutoFill"`
		BaseMetadata  *PieceInput   `json:"baseMetadata"`
	}
	if err = json.Unmarshal(metadata, &draftOnly); err != nil {
		return d, err
	}
	d.IMSLPAutoFill = draftOnly.IMSLPAutoFill
	d.BaseMetadata = draftOnly.BaseMetadata
	if err = json.Unmarshal(manifest, &d.Manifest); err != nil {
		return d, err
	}
	err = json.Unmarshal(initial, &d.InitialManifest)
	return d, err
}

func marshalDraftMetadata(metadata PieceInput, provenance IMSLPAutoFill, base *PieceInput) ([]byte, error) {
	return json.Marshal(struct {
		PieceInput
		IMSLPAutoFill IMSLPAutoFill `json:"imslpAutoFill"`
		BaseMetadata  *PieceInput   `json:"baseMetadata,omitempty"`
	}{metadata, provenance, base})
}

func validateIMSLPAutoFill(metadata PieceInput, provenance IMSLPAutoFill) error {
	if provenance.Title != nil && (provenance.TitleEdited || len(*provenance.Title) > 300 || *provenance.Title != metadata.Title) {
		return invalid("IMSLP title ownership must match the draft title")
	}
	if provenance.Composer != nil && (provenance.ComposerEdited || len(*provenance.Composer) > 300 || *provenance.Composer != metadata.Composer) {
		return invalid("IMSLP composer ownership must match the draft composer")
	}
	return nil
}
func (s *Service) draftTx(ctx context.Context, tx pgx.Tx, owner, id string) (ImportDraft, error) {
	d, err := scanDraft(tx.QueryRow(ctx, `SELECT `+draftColumns+` FROM import_drafts WHERE id=$1 AND user_id=$2 AND updated_at>now()-interval '7 days' FOR UPDATE`, id, owner))
	if err != nil {
		return d, err
	}
	rows, err := tx.Query(ctx, `SELECT a.id,a.original_filename,a.mime_type,a.size_bytes,a.checksum_sha256,a.page_count,a.width,a.height,a.created_at,a.storage_key FROM import_assets a JOIN draft_sources ds ON ds.asset_id=a.id WHERE ds.draft_id=$1 AND a.user_id=$2 ORDER BY a.created_at,a.id`, id, owner)
	if err != nil {
		return d, err
	}
	defer rows.Close()
	d.Sources = []ImportAsset{}
	for rows.Next() {
		var a ImportAsset
		if err = rows.Scan(&a.ID, &a.Filename, &a.MIME, &a.Size, &a.Checksum, &a.PageCount, &a.Width, &a.Height, &a.CreatedAt, &a.StorageKey); err != nil {
			return d, err
		}
		d.Sources = append(d.Sources, a)
	}
	d.MaxFileBytes = s.importLimit()
	return d, rows.Err()
}
func (s *Service) GetImport(ctx context.Context, owner, id string) (ImportDraft, error) {
	tx, err := s.importTx(ctx, owner)
	if err != nil {
		return ImportDraft{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
	return s.draftTx(ctx, tx, owner, id)
}
func (s *Service) ListImports(ctx context.Context, owner string) ([]ImportDraft, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+draftColumns+` FROM import_drafts WHERE user_id=$1 AND NOT finalized AND updated_at>now()-interval '7 days' ORDER BY updated_at DESC`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	drafts := []ImportDraft{}
	for rows.Next() {
		d, err := scanDraft(rows)
		if err != nil {
			return nil, err
		}
		d.MaxFileBytes = s.importLimit()
		drafts = append(drafts, d)
	}
	return drafts, rows.Err()
}
func (s *Service) CreateImport(ctx context.Context, owner string, input CreateImport) (ImportDraft, error) {
	return s.createImport(ctx, owner, input, nil)
}

// createImport starts a draft. A work prefills the title and composer and owns
// them as IMSLP values, as choosing that work on the Prepare screen does.
func (s *Service) createImport(ctx context.Context, owner string, input CreateImport, work *IMSLPWork) (ImportDraft, error) {
	if input.SourceURL != "" {
		if err := ValidateIMSLP(input.SourceURL); err != nil {
			return ImportDraft{}, err
		}
	}
	tx, err := s.importTx(ctx, owner)
	if err != nil {
		return ImportDraft{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM import_drafts WHERE user_id=$1 AND NOT finalized AND updated_at>now()-interval '7 days'`, owner).Scan(&count); err != nil {
		return ImportDraft{}, err
	}
	if count >= maxOpenDrafts {
		return ImportDraft{}, ErrDraftLimit
	}
	d := ImportDraft{ID: uuid.NewString(), Manifest: EditManifest{Version: 1, Pages: []PageEdit{}}, Metadata: PieceInput{SourceURL: input.SourceURL}}
	if work != nil && input.PieceID == "" {
		// A value too long to save is left for the user rather than failing the draft.
		if title := work.Title; len(title) <= 300 {
			d.Metadata.Title, d.IMSLPAutoFill.Title = title, &title
		}
		if composer := work.Composer; len(composer) <= 300 {
			d.Metadata.Composer, d.IMSLPAutoFill.Composer = composer, &composer
		}
	}
	var sources []string
	if input.PieceID != "" {
		if _, err = uuid.Parse(input.PieceID); err != nil {
			return d, invalid("piece id must be a UUID")
		}
		d.PieceID = &input.PieceID
		var saved []byte
		err = tx.QueryRow(ctx, `SELECT title,composer,favorite,source_url,listening_url,notes,content_revision,preparation_manifest FROM pieces WHERE id=$1 AND user_id=$2 FOR UPDATE`, input.PieceID, owner).Scan(&d.Metadata.Title, &d.Metadata.Composer, &d.Metadata.Favorite, &d.Metadata.SourceURL, &d.Metadata.ListeningURL, &d.Metadata.Notes, &d.BaseRevision, &saved)
		if errors.Is(err, pgx.ErrNoRows) {
			return d, ErrNotFound
		}
		if err != nil {
			return d, err
		}
		base := d.Metadata
		d.BaseMetadata = &base
		if len(saved) > 0 {
			if err = json.Unmarshal(saved, &d.Manifest); err != nil {
				return d, err
			}
			if len(d.Manifest.Pages) > MaxPreparedPages {
				return d, ErrTooManyPages
			}
			for _, p := range d.Manifest.Pages {
				sources = append(sources, p.SourceID)
			}
		} else {
			var a ImportAsset
			err = tx.QueryRow(ctx, `SELECT storage_key,original_filename,size_bytes,checksum_sha256,page_count FROM piece_pdfs WHERE piece_id=$1`, input.PieceID).Scan(&a.StorageKey, &a.Filename, &a.Size, &a.Checksum, &a.PageCount)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return d, err
			}
			if err == nil && a.PageCount > MaxPreparedPages {
				return d, ErrTooManyPages
			}
			if err == nil {
				// Retain the existing opaque object key without copying PDF bytes.
				a.ID = uuid.NewString()
				a.MIME = "application/pdf"
				err = tx.QueryRow(ctx, `INSERT INTO import_assets(id,user_id,storage_key,original_filename,mime_type,size_bytes,checksum_sha256,page_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(storage_key) DO UPDATE SET storage_key=excluded.storage_key RETURNING id`, a.ID, owner, a.StorageKey, a.Filename, a.MIME, a.Size, a.Checksum, a.PageCount).Scan(&a.ID)
				if err != nil {
					return d, err
				}
				sources = append(sources, a.ID)
				for n := 0; n < a.PageCount; n++ {
					d.Manifest.Pages = append(d.Manifest.Pages, PageEdit{ID: uuid.NewString(), SourceID: a.ID, Page: n})
				}
			}
		}
	}
	d.InitialManifest = d.Manifest
	meta, err := marshalDraftMetadata(d.Metadata, d.IMSLPAutoFill, d.BaseMetadata)
	if err != nil {
		return d, err
	}
	manifest, err := json.Marshal(d.Manifest)
	if err != nil {
		return d, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO import_drafts(id,user_id,piece_id,base_revision,metadata,manifest,initial_manifest) VALUES($1,$2,$3,$4,$5,$6,$6)`, d.ID, owner, d.PieceID, d.BaseRevision, meta, manifest)
	if err != nil {
		return d, err
	}
	for _, id := range sources {
		if _, err = tx.Exec(ctx, `INSERT INTO draft_sources VALUES($1,$2) ON CONFLICT DO NOTHING`, d.ID, id); err != nil {
			return d, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return d, err
	}
	return s.GetImport(ctx, owner, d.ID)
}
func (s *Service) UpdateImport(ctx context.Context, owner, id string, input UpdateImport) (ImportDraft, error) {
	tx, err := s.importTx(ctx, owner)
	if err != nil {
		return ImportDraft{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
	d, err := s.draftTx(ctx, tx, owner, id)
	if err != nil {
		return d, err
	}
	if d.Finalized || d.Revision != input.Revision {
		return d, ErrConflict
	}
	if err = validateManifest(input.Manifest, d.Sources, true); err != nil {
		return d, err
	}
	// Empty title allowed in drafts; final save validates all metadata.
	metadata := input.Metadata
	if strings.TrimSpace(metadata.Title) == "" {
		metadata.Title = "Untitled score"
	}
	if _, err = validatePiece(metadata); err != nil {
		return d, err
	}
	// Status is set from the library; finalizing a draft never changes it.
	if metadata.Status != nil {
		return d, invalid("a draft cannot set the piece status")
	}
	if metadata.Opus != "" || metadata.MusicKey != "" {
		return d, invalid("a draft cannot set opus or music key")
	}
	if metadata.Aliases != "" {
		return d, invalid("a draft cannot set the piece aliases")
	}
	if err = validateIMSLPAutoFill(input.Metadata, input.IMSLPAutoFill); err != nil {
		return d, err
	}
	meta, err := marshalDraftMetadata(input.Metadata, input.IMSLPAutoFill, d.BaseMetadata)
	if err != nil {
		return d, err
	}
	manifest, err := json.Marshal(input.Manifest)
	if err != nil {
		return d, err
	}
	_, err = tx.Exec(ctx, `UPDATE import_drafts SET metadata=$2,manifest=$3,revision=revision+1,updated_at=now() WHERE id=$1`, id, meta, manifest)
	if err != nil {
		return d, err
	}
	if err = tx.Commit(ctx); err != nil {
		return d, err
	}
	return s.GetImport(ctx, owner, id)
}
func (s *Service) DeleteImport(ctx context.Context, owner, id string) error {
	tx, err := s.importTx(ctx, owner)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
	var finalized bool
	err = tx.QueryRow(ctx, `SELECT finalized FROM import_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, owner).Scan(&finalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if finalized {
		return ErrConflict
	}
	tag, err := tx.Exec(ctx, `DELETE FROM import_drafts WHERE id=$1 AND user_id=$2`, id, owner)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err = collectOrphans(ctx, tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
