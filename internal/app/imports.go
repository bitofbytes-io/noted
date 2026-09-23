package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strings"
	"time"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrConflict = errors.New("draft changed; reload before saving")
var ErrPieceChanged = errors.New("saved piece changed; your draft is retained. Start a new preparation from the current piece before saving")
var ErrImportLimit = errors.New("import limit reached")

func (s *Service) importLimit() int64 {
	if s.maxUploadBytes > 0 {
		return s.maxUploadBytes
	}
	return 50 << 20
}
func lockOwner(ctx context.Context, tx pgx.Tx, owner string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, owner)
	return err
}
func (s *Service) importTx(ctx context.Context, owner string) (pgx.Tx, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if err = lockOwner(ctx, tx, owner); err != nil {
		tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

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
	}
	if err = json.Unmarshal(metadata, &draftOnly); err != nil {
		return d, err
	}
	d.IMSLPAutoFill = draftOnly.IMSLPAutoFill
	if err = json.Unmarshal(manifest, &d.Manifest); err != nil {
		return d, err
	}
	err = json.Unmarshal(initial, &d.InitialManifest)
	return d, err
}

func marshalDraftMetadata(metadata PieceInput, provenance IMSLPAutoFill) ([]byte, error) {
	return json.Marshal(struct {
		PieceInput
		IMSLPAutoFill IMSLPAutoFill `json:"imslpAutoFill"`
	}{metadata, provenance})
}

func validateIMSLPAutoFill(metadata PieceInput, provenance IMSLPAutoFill) error {
	if provenance.Title != nil && (provenance.TitleEdited || len(*provenance.Title) > 300 || *provenance.Title != metadata.Title) {
		return fmt.Errorf("IMSLP title ownership must match the draft title")
	}
	if provenance.Composer != nil && (provenance.ComposerEdited || len(*provenance.Composer) > 300 || *provenance.Composer != metadata.Composer) {
		return fmt.Errorf("IMSLP composer ownership must match the draft composer")
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
	defer tx.Rollback(ctx)
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
	if input.SourceURL != "" {
		if err := ValidateIMSLP(input.SourceURL); err != nil {
			return ImportDraft{}, err
		}
	}
	tx, err := s.importTx(ctx, owner)
	if err != nil {
		return ImportDraft{}, err
	}
	defer tx.Rollback(ctx)
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM import_drafts WHERE user_id=$1 AND NOT finalized AND updated_at>now()-interval '7 days'`, owner).Scan(&count); err != nil {
		return ImportDraft{}, err
	}
	if count >= 20 {
		return ImportDraft{}, ErrImportLimit
	}
	d := ImportDraft{ID: uuid.NewString(), Manifest: EditManifest{Version: 1, Pages: []PageEdit{}}, Metadata: PieceInput{SourceURL: input.SourceURL}}
	var sources []string
	if input.PieceID != "" {
		if _, err = uuid.Parse(input.PieceID); err != nil {
			return d, fmt.Errorf("piece id must be a UUID")
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
		if len(saved) > 0 {
			if err = json.Unmarshal(saved, &d.Manifest); err != nil {
				return d, err
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
			if err == nil {
				// Retain the existing opaque object key without copying PDF bytes.
				a.ID = uuid.NewString()
				a.MIME = "application/pdf"
				err = tx.QueryRow(ctx, `INSERT INTO import_assets(id,user_id,storage_key,original_filename,mime_type,size_bytes,checksum_sha256,page_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(storage_key) DO UPDATE SET storage_key=excluded.storage_key RETURNING id`, a.ID, owner, a.StorageKey, a.Filename, a.MIME, a.Size, a.Checksum, a.PageCount).Scan(&a.ID)
				if err != nil {
					return d, err
				}
				sources = append(sources, a.ID)
				for n := 0; n < a.PageCount && n < 100; n++ {
					d.Manifest.Pages = append(d.Manifest.Pages, PageEdit{ID: uuid.NewString(), SourceID: a.ID, Page: n})
				}
			}
		}
	}
	d.InitialManifest = d.Manifest
	meta, _ := marshalDraftMetadata(d.Metadata, d.IMSLPAutoFill)
	manifest, _ := json.Marshal(d.Manifest)
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
	defer tx.Rollback(ctx)
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
	if err = validateIMSLPAutoFill(input.Metadata, input.IMSLPAutoFill); err != nil {
		return d, err
	}
	meta, _ := marshalDraftMetadata(input.Metadata, input.IMSLPAutoFill)
	manifest, _ := json.Marshal(input.Manifest)
	_, err = tx.Exec(ctx, `UPDATE import_drafts SET metadata=$2,manifest=$3,revision=revision+1,updated_at=now() WHERE id=$1`, id, meta, manifest)
	if err != nil {
		return d, err
	}
	if err = tx.Commit(ctx); err != nil {
		return d, err
	}
	return s.GetImport(ctx, owner, id)
}
func (s *Service) UploadImportSource(ctx context.Context, owner, id, filename string, revision int64, reader io.Reader) (ImportDraft, error) {
	data, err := io.ReadAll(io.LimitReader(reader, s.importLimit()+1))
	if err != nil {
		return ImportDraft{}, err
	}
	if int64(len(data)) > s.importLimit() {
		return ImportDraft{}, ErrImportLimit
	}
	mime, count, w, h, err := ValidateImportBytes(data)
	if err != nil {
		return ImportDraft{}, err
	}
	tx, err := s.importTx(ctx, owner)
	if err != nil {
		return ImportDraft{}, err
	}
	defer tx.Rollback(ctx)
	d, err := s.draftTx(ctx, tx, owner, id)
	if err != nil {
		return d, err
	}
	if d.Finalized || d.Revision != revision {
		return d, ErrConflict
	}
	var total int64
	for _, a := range d.Sources {
		total += a.Size
	}
	if total+int64(len(data)) > 200<<20 {
		return d, ErrImportLimit
	}
	object, err := s.store.Save(ctx, bytes.NewReader(data))
	if err != nil {
		return d, err
	}
	committed := false
	defer func() {
		if !committed {
			cleanupCtx := context.WithoutCancel(ctx)
			_ = tx.Rollback(cleanupCtx)
			s.queueObject(cleanupCtx, object.Key)
		}
	}()
	a := ImportAsset{ID: uuid.NewString()}
	_, err = tx.Exec(ctx, `INSERT INTO import_assets(id,user_id,storage_key,original_filename,mime_type,size_bytes,checksum_sha256,page_count,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, a.ID, owner, object.Key, filename, mime, object.Size, object.Checksum, count, w, h)
	if err != nil {
		return d, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO draft_sources VALUES($1,$2)`, id, a.ID); err != nil {
		return d, err
	}
	for n := 0; n < count && len(d.Manifest.Pages) < 100; n++ {
		d.Manifest.Pages = append(d.Manifest.Pages, PageEdit{ID: uuid.NewString(), SourceID: a.ID, Page: n})
	}
	if d.Metadata.Title == "" && !d.IMSLPAutoFill.TitleEdited {
		d.Metadata.Title = strings.TrimSuffix(filename, ".pdf")
		// The filename is an automatic fallback, not a user edit. Own it so
		// choosing a work later can replace it.
		d.IMSLPAutoFill.Title = &d.Metadata.Title
	}
	manifest, _ := json.Marshal(d.Manifest)
	meta, _ := marshalDraftMetadata(d.Metadata, d.IMSLPAutoFill)
	_, err = tx.Exec(ctx, `UPDATE import_drafts SET manifest=$2,metadata=$3,revision=revision+1,updated_at=now() WHERE id=$1`, id, manifest, meta)
	if err != nil {
		return d, err
	}
	if err = tx.Commit(ctx); err != nil {
		return d, err
	}
	committed = true
	return s.GetImport(ctx, owner, id)
}
func (s *Service) ImportSource(ctx context.Context, owner, draftID, assetID string) (ImportAsset, assets.ReadSeekCloser, error) {
	var a ImportAsset
	err := s.pool.QueryRow(ctx, `SELECT a.id,a.storage_key,a.original_filename,a.mime_type,a.created_at FROM import_assets a JOIN draft_sources ds ON ds.asset_id=a.id JOIN import_drafts d ON d.id=ds.draft_id WHERE a.id=$1 AND d.id=$2 AND a.user_id=$3 AND d.user_id=$3 AND NOT d.finalized AND d.updated_at>now()-interval '7 days'`, assetID, draftID, owner).Scan(&a.ID, &a.StorageKey, &a.Filename, &a.MIME, &a.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, nil, ErrNotFound
	}
	if err != nil {
		return a, nil, err
	}
	reader, err := s.store.Open(ctx, a.StorageKey)
	if errors.Is(err, fs.ErrNotExist) {
		err = ErrNotFound
	}
	return a, reader, err
}
func (s *Service) FinalizeImport(ctx context.Context, owner, id string, revision int64, reader io.Reader) (Piece, error) {
	tx, err := s.importTx(ctx, owner)
	if err != nil {
		return Piece{}, err
	}
	defer tx.Rollback(ctx)
	d, err := s.draftTx(ctx, tx, owner, id)
	if err != nil {
		return Piece{}, err
	}
	if d.Revision != revision {
		return Piece{}, ErrConflict
	}
	if d.Finalized && d.PieceID != nil {
		_ = tx.Rollback(ctx)
		return s.GetPiece(ctx, owner, *d.PieceID)
	}
	if err = validateManifest(d.Manifest, d.Sources, false); err != nil {
		return Piece{}, err
	}
	metadata, err := validatePiece(d.Metadata)
	if err != nil {
		return Piece{}, err
	}
	data, err := io.ReadAll(io.LimitReader(reader, s.importLimit()+1))
	if err != nil {
		return Piece{}, err
	}
	if int64(len(data)) > s.importLimit() {
		return Piece{}, ErrImportLimit
	}
	mime, count, _, _, err := ValidateImportBytes(data)
	if err != nil {
		return Piece{}, err
	}
	if mime != "application/pdf" || count != len(d.Manifest.Pages) {
		return Piece{}, fmt.Errorf("output PDF must have exactly the prepared page count")
	}
	var oldKey, oldChecksum string
	var oldPageCount int
	if d.PieceID != nil {
		var rev int64
		err = tx.QueryRow(ctx, `SELECT content_revision FROM pieces WHERE id=$1 AND user_id=$2 FOR UPDATE`, *d.PieceID, owner).Scan(&rev)
		if errors.Is(err, pgx.ErrNoRows) {
			return Piece{}, ErrNotFound
		}
		if err != nil {
			return Piece{}, err
		}
		if rev != d.BaseRevision {
			return Piece{}, ErrPieceChanged
		}
		err = tx.QueryRow(ctx, `SELECT storage_key,checksum_sha256,page_count FROM piece_pdfs WHERE piece_id=$1`, *d.PieceID).Scan(&oldKey, &oldChecksum, &oldPageCount)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return Piece{}, err
		}
	} else {
		newID := uuid.NewString()
		d.PieceID = &newID
		_, err = tx.Exec(ctx, `INSERT INTO pieces(id,user_id,title) VALUES($1,$2,$3)`, newID, owner, metadata.Title)
		if err != nil {
			return Piece{}, err
		}
	}
	manifestBytes, _ := json.Marshal(d.Manifest)
	initialBytes, _ := json.Marshal(d.InitialManifest)
	if oldKey != "" && oldPageCount == count && bytes.Equal(manifestBytes, initialBytes) {
		original, openErr := s.store.Open(ctx, oldKey)
		if openErr != nil {
			return Piece{}, openErr
		}
		data, err = io.ReadAll(original)
		original.Close()
		if err != nil {
			return Piece{}, err
		}
	}
	object, err := s.store.Save(ctx, bytes.NewReader(data))
	if err != nil {
		return Piece{}, err
	}
	committed := false
	defer func() {
		if !committed {
			cleanupCtx := context.WithoutCancel(ctx)
			_ = tx.Rollback(cleanupCtx)
			s.queueObject(cleanupCtx, object.Key)
		}
	}()
	manifest, _ := json.Marshal(d.Manifest)
	_, err = tx.Exec(ctx, `UPDATE pieces SET title=$2,composer=$3,favorite=$4,source_url=$5,listening_url=$6,notes=$7,preparation_manifest=$8,content_revision=content_revision+1,updated_at=now() WHERE id=$1`, *d.PieceID, metadata.Title, metadata.Composer, metadata.Favorite, metadata.SourceURL, metadata.ListeningURL, metadata.Notes, manifest)
	if err != nil {
		return Piece{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO piece_pdfs(piece_id,storage_key,original_filename,size_bytes,checksum_sha256,page_count) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(piece_id) DO UPDATE SET storage_key=excluded.storage_key,original_filename=excluded.original_filename,size_bytes=excluded.size_bytes,checksum_sha256=excluded.checksum_sha256,page_count=excluded.page_count,uploaded_at=now()`, *d.PieceID, object.Key, metadata.Title+".pdf", object.Size, object.Checksum, count)
	if err != nil {
		return Piece{}, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM piece_sources WHERE piece_id=$1`, *d.PieceID); err != nil {
		return Piece{}, err
	}
	for _, p := range d.Manifest.Pages {
		if _, err = tx.Exec(ctx, `INSERT INTO piece_sources VALUES($1,$2) ON CONFLICT DO NOTHING`, *d.PieceID, p.SourceID); err != nil {
			return Piece{}, err
		}
	}
	if oldChecksum != object.Checksum {
		if _, err = tx.Exec(ctx, `UPDATE reader_states SET last_page=1,scroll_position=0,zoom=1,scroll_paused=true,updated_at=now() WHERE piece_id=$1`, *d.PieceID); err != nil {
			return Piece{}, err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE import_drafts SET finalized=true,piece_id=$2,updated_at=now() WHERE id=$1`, id, *d.PieceID)
	if err != nil {
		return Piece{}, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM draft_sources WHERE draft_id=$1`, id); err != nil {
		return Piece{}, err
	}
	if err = collectOrphans(ctx, tx); err != nil {
		return Piece{}, err
	}
	if oldKey != "" {
		if err = queueKey(ctx, tx, oldKey); err != nil {
			return Piece{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Piece{}, err
	}
	committed = true
	return s.GetPiece(ctx, owner, *d.PieceID)
}
func (s *Service) DeleteImport(ctx context.Context, owner, id string) error {
	tx, err := s.importTx(ctx, owner)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
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
func queueKey(ctx context.Context, tx pgx.Tx, key string) error {
	_, err := tx.Exec(ctx, `INSERT INTO asset_deletion_queue(storage_key) SELECT $1 WHERE NOT EXISTS(SELECT 1 FROM piece_pdfs WHERE storage_key=$1) AND NOT EXISTS(SELECT 1 FROM import_assets WHERE storage_key=$1) ON CONFLICT DO NOTHING`, key)
	return err
}
func collectOrphans(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `WITH removed AS (DELETE FROM import_assets a WHERE NOT EXISTS(SELECT 1 FROM draft_sources WHERE asset_id=a.id) AND NOT EXISTS(SELECT 1 FROM piece_sources WHERE asset_id=a.id) RETURNING storage_key) INSERT INTO asset_deletion_queue(storage_key) SELECT storage_key FROM removed WHERE NOT EXISTS(SELECT 1 FROM piece_pdfs f WHERE f.storage_key=removed.storage_key) ON CONFLICT DO NOTHING`)
	return err
}
func (s *Service) queueObject(ctx context.Context, key string) {
	_, _ = s.pool.Exec(ctx, `INSERT INTO asset_deletion_queue(storage_key) VALUES($1) ON CONFLICT DO NOTHING`, key)
}

// Durable retries: deleting files happens only after committed references disappear.
func (s *Service) CleanupImports(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `DELETE FROM import_drafts WHERE updated_at<now()-interval '7 days'`); err != nil {
		return err
	}
	if err = collectOrphans(ctx, tx); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	rows, err := s.pool.Query(ctx, `SELECT storage_key FROM asset_deletion_queue ORDER BY queued_at LIMIT 100`)
	if err != nil {
		return err
	}
	keys := []string{}
	for rows.Next() {
		var k string
		if err = rows.Scan(&k); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, k)
	}
	rows.Close()
	for _, k := range keys {
		var referenced bool
		if err = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM import_assets WHERE storage_key=$1) OR EXISTS(SELECT 1 FROM piece_pdfs WHERE storage_key=$1)`, k).Scan(&referenced); err != nil {
			return err
		}
		if referenced {
			continue
		}
		if err = s.store.Delete(ctx, k); err != nil {
			_, _ = s.pool.Exec(ctx, `UPDATE asset_deletion_queue SET attempts=attempts+1 WHERE storage_key=$1`, k)
			continue
		}
		if _, err = s.pool.Exec(ctx, `DELETE FROM asset_deletion_queue WHERE storage_key=$1`, k); err != nil {
			return err
		}
	}
	return nil
}
func (s *Service) RunImportCleanup(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		_ = s.CleanupImports(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
