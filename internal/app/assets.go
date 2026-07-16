package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"mime/multipart"
	"strings"

	assetstore "github.com/bitofbytes-io/noted/internal/assets"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type UploadMetadata struct {
	SourceURL          string
	RightsNote         string
	ReplacesAssetID    string
	DerivedFromAssetID string
	VerificationState  string
}

type AssetPatchInput struct {
	DisplayName *string `json:"displayName"`
	SourceURL   *string `json:"sourceUrl"`
	RightsNote  *string `json:"rightsNote"`
	Archived    *bool   `json:"archived"`
}

type assetRecord struct {
	Asset
	StorageKey string
}

func (s *Service) UploadAsset(ctx context.Context, userID, editionID string, header *multipart.FileHeader, file multipart.File, metadata UploadMetadata) (Asset, error) {
	if err := validateResourceID(editionID); err != nil {
		return Asset{}, err
	}
	if strings.TrimSpace(metadata.RightsNote) == "" {
		return Asset{}, ValidationError{Fields: map[string]string{"rightsNote": "is required"}}
	}
	if metadata.ReplacesAssetID != "" {
		if err := validateResourceID(metadata.ReplacesAssetID); err != nil {
			return Asset{}, err
		}
	}
	if metadata.DerivedFromAssetID != "" {
		if err := validateResourceID(metadata.DerivedFromAssetID); err != nil {
			return Asset{}, err
		}
	}
	if metadata.VerificationState == "" {
		metadata.VerificationState = "original"
	}
	format, stream, err := assetstore.DetectUpload(header, file)
	if err != nil {
		return Asset{}, err
	}
	key := format.AssetType + "/" + uuid.NewString()
	stored, err := s.Store.Put(ctx, key, stream)
	if err != nil {
		return Asset{}, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = s.Store.Delete(context.Background(), key)
		}
	}()

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Asset{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- a committed transaction makes rollback a no-op
	var asset Asset
	err = tx.QueryRow(ctx, `
		INSERT INTO score_assets(edition_id,asset_type,storage_key,original_filename,display_name,media_type,byte_size,sha256,source_url,rights_note,playback_capable,uploaded_by_user_id,replaces_asset_id,derived_from_asset_id,verification_state)
		SELECT e.id,$3,$4,$5,$5,$6,$7,$8,NULLIF($9,''),$10,$11,$1,NULLIF($12,'')::uuid,NULLIF($13,'')::uuid,$14
		FROM editions e JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE lw.user_id=$1 AND e.id=$2 AND e.archived_at IS NULL
		  AND ($12='' OR EXISTS(SELECT 1 FROM score_assets old WHERE old.id=NULLIF($12,'')::uuid AND old.edition_id=e.id AND old.uploaded_by_user_id=$1))
		  AND ($13='' OR EXISTS(SELECT 1 FROM score_assets source WHERE source.id=NULLIF($13,'')::uuid AND source.edition_id=e.id AND source.uploaded_by_user_id=$1))
		RETURNING id::text,edition_id::text,asset_type,original_filename,COALESCE(display_name,original_filename),media_type,byte_size,sha256,COALESCE(source_url,''),rights_note,playback_capable,archived_at,replaces_asset_id::text,derived_from_asset_id::text,verification_state,created_at`,
		userID, editionID, format.AssetType, key, header.Filename, format.MediaType, stored.Size, stored.Checksum,
		metadata.SourceURL, metadata.RightsNote, format.AssetType == "musicxml", metadata.ReplacesAssetID,
		metadata.DerivedFromAssetID, metadata.VerificationState,
	).Scan(&asset.ID, &asset.EditionID, &asset.AssetType, &asset.OriginalFilename, &asset.DisplayName, &asset.MediaType, &asset.ByteSize, &asset.SHA256, &asset.SourceURL, &asset.RightsNote, &asset.PlaybackCapable, &asset.ArchivedAt, &asset.ReplacesAssetID, &asset.DerivedFromAssetID, &asset.VerificationState, &asset.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Asset{}, ErrNotFound
	}
	if err != nil {
		return Asset{}, fmt.Errorf("record asset metadata: %w", err)
	}
	if metadata.ReplacesAssetID != "" {
		if _, err := tx.Exec(ctx, `UPDATE score_assets SET archived_at=now(),updated_at=now() WHERE id=$1 AND uploaded_by_user_id=$2`, metadata.ReplacesAssetID, userID); err != nil {
			return Asset{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Asset{}, err
	}
	cleanup = false
	asset.ContentURL = "/api/assets/" + asset.ID + "/content"
	return asset, nil
}

func (s *Service) ListEditionAssets(ctx context.Context, userID, editionID string) ([]Asset, error) {
	if err := validateResourceID(editionID); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT a.id::text,a.edition_id::text,a.asset_type,a.original_filename,COALESCE(a.display_name,a.original_filename),a.media_type,a.byte_size,a.sha256,COALESCE(a.source_url,''),a.rights_note,a.playback_capable,a.archived_at,a.replaces_asset_id::text,a.derived_from_asset_id::text,a.verification_state,a.created_at
		FROM score_assets a JOIN editions e ON e.id=a.edition_id JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE lw.user_id=$1 AND a.uploaded_by_user_id=$1 AND a.edition_id=$2 ORDER BY a.created_at`, userID, editionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Asset{}
	for rows.Next() {
		var item Asset
		if err := rows.Scan(&item.ID, &item.EditionID, &item.AssetType, &item.OriginalFilename, &item.DisplayName, &item.MediaType, &item.ByteSize, &item.SHA256, &item.SourceURL, &item.RightsNote, &item.PlaybackCapable, &item.ArchivedAt, &item.ReplacesAssetID, &item.DerivedFromAssetID, &item.VerificationState, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.ContentURL = "/api/assets/" + item.ID + "/content"
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) getAssetRecord(ctx context.Context, userID, assetID string) (assetRecord, error) {
	if err := validateResourceID(assetID); err != nil {
		return assetRecord{}, err
	}
	var item assetRecord
	err := s.Pool.QueryRow(ctx, `
		SELECT a.id::text,a.edition_id::text,a.asset_type,a.original_filename,COALESCE(a.display_name,a.original_filename),a.media_type,a.byte_size,a.sha256,COALESCE(a.source_url,''),a.rights_note,a.playback_capable,a.archived_at,a.replaces_asset_id::text,a.derived_from_asset_id::text,a.verification_state,a.created_at,a.storage_key
		FROM score_assets a JOIN editions e ON e.id=a.edition_id JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE lw.user_id=$1 AND a.uploaded_by_user_id=$1 AND a.id=$2`, userID, assetID).Scan(
		&item.ID, &item.EditionID, &item.AssetType, &item.OriginalFilename, &item.DisplayName, &item.MediaType, &item.ByteSize,
		&item.SHA256, &item.SourceURL, &item.RightsNote, &item.PlaybackCapable, &item.ArchivedAt, &item.ReplacesAssetID, &item.DerivedFromAssetID, &item.VerificationState, &item.CreatedAt, &item.StorageKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return assetRecord{}, ErrNotFound
	}
	item.ContentURL = "/api/assets/" + item.ID + "/content"
	return item, err
}

func (s *Service) UpdateAsset(ctx context.Context, userID, assetID string, input AssetPatchInput) (Asset, error) {
	if err := validateResourceID(assetID); err != nil {
		return Asset{}, err
	}
	fields := map[string]string{}
	if input.DisplayName != nil && strings.TrimSpace(*input.DisplayName) == "" {
		fields["displayName"] = "is required"
	}
	if input.RightsNote != nil && strings.TrimSpace(*input.RightsNote) == "" {
		fields["rightsNote"] = "is required"
	}
	if len(fields) > 0 {
		return Asset{}, ValidationError{Fields: fields}
	}
	result, err := s.Pool.Exec(ctx, `
		UPDATE score_assets a SET
			display_name=CASE WHEN $3::text IS NULL THEN a.display_name ELSE btrim($3) END,
			source_url=CASE WHEN $4::text IS NULL THEN a.source_url ELSE NULLIF(btrim($4),'') END,
			rights_note=CASE WHEN $5::text IS NULL THEN a.rights_note ELSE btrim($5) END,
			archived_at=CASE WHEN $6::boolean IS NULL THEN a.archived_at WHEN $6 THEN COALESCE(a.archived_at,now()) ELSE NULL END,
			updated_at=now()
		FROM editions e JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE a.edition_id=e.id AND lw.user_id=$1 AND a.uploaded_by_user_id=$1 AND a.id=$2`,
		userID, assetID, input.DisplayName, input.SourceURL, input.RightsNote, input.Archived)
	if err != nil {
		return Asset{}, err
	}
	if result.RowsAffected() == 0 {
		return Asset{}, ErrNotFound
	}
	return s.GetAsset(ctx, userID, assetID)
}

func (s *Service) GetAsset(ctx context.Context, userID, assetID string) (Asset, error) {
	item, err := s.getAssetRecord(ctx, userID, assetID)
	return item.Asset, err
}

func (s *Service) OpenAsset(ctx context.Context, userID, assetID string) (assetRecord, multipart.File, error) {
	item, err := s.getAssetRecord(ctx, userID, assetID)
	if err != nil {
		return assetRecord{}, nil, err
	}
	reader, _, err := s.Store.Open(ctx, item.StorageKey)
	if err != nil {
		return assetRecord{}, nil, err
	}
	file, ok := reader.(multipart.File)
	if !ok {
		reader.Close()
		return assetRecord{}, nil, fmt.Errorf("asset store does not expose a seekable file")
	}
	return item, file, nil
}

func (s *Service) DeleteAsset(ctx context.Context, userID, assetID string) error {
	if err := validateResourceID(assetID); err != nil {
		return err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- a committed transaction makes rollback a no-op

	var storageKey string
	err = tx.QueryRow(ctx, `
		SELECT a.storage_key
		FROM score_assets a
		JOIN editions e ON e.id=a.edition_id
		JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE lw.user_id=$1 AND a.uploaded_by_user_id=$1 AND a.id=$2
		FOR UPDATE OF a`, userID, assetID).Scan(&storageKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	var referenced bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM practice_sessions WHERE score_asset_id=$1) OR EXISTS(SELECT 1 FROM score_assets WHERE derived_from_asset_id=$1)`, assetID).Scan(&referenced); err != nil {
		return err
	}
	if referenced {
		return ErrAssetInUse
	}
	result, err := tx.Exec(ctx, `DELETE FROM score_assets WHERE uploaded_by_user_id=$1 AND id=$2`, userID, assetID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if err := s.Store.Delete(context.Background(), storageKey); err != nil {
		slog.Error("asset metadata deleted but storage cleanup failed", "asset_id", assetID, "storage_key", storageKey, "error", err)
	}
	return nil
}
