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

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

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
	return s.attachSource(ctx, owner, id, filename, revision, validatedSource{data, mime, count, w, h})
}

// validatedSource is a file that already passed ValidateImportBytes.
type validatedSource struct {
	data          []byte
	mime          string
	pages         int
	width, height int
}

func (s *Service) attachSource(ctx context.Context, owner, id, filename string, revision int64, source validatedSource) (ImportDraft, error) {
	data, mime, count, w, h := source.data, source.mime, source.pages, source.width, source.height
	tx, err := s.importTx(ctx, owner)
	if err != nil {
		return ImportDraft{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
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
		return d, fmt.Errorf("%w: %w", ErrAssetStore, err)
	}
	committed := false
	defer func() {
		if !committed {
			cleanupCtx := context.WithoutCancel(ctx)
			_ = tx.Rollback(cleanupCtx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
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
	for n := 0; n < count && len(d.Manifest.Pages) < MaxPreparedPages; n++ {
		d.Manifest.Pages = append(d.Manifest.Pages, PageEdit{ID: uuid.NewString(), SourceID: a.ID, Page: n})
	}
	if d.Metadata.Title == "" && !d.IMSLPAutoFill.TitleEdited {
		d.Metadata.Title = strings.TrimSuffix(filename, ".pdf")
		// The filename is an automatic fallback, not a user edit. Own it so
		// choosing a work later can replace it.
		d.IMSLPAutoFill.Title = &d.Metadata.Title
	}
	manifest, err := json.Marshal(d.Manifest)
	if err != nil {
		return d, err
	}
	meta, err := marshalDraftMetadata(d.Metadata, d.IMSLPAutoFill, d.BaseMetadata)
	if err != nil {
		return d, err
	}
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
