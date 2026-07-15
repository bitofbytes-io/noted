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
	SourceURL  string
	RightsNote string
}

type assetRecord struct {
	Asset
	StorageKey string
}

func (s *Service) UploadAsset(ctx context.Context, userID, editionID string, header *multipart.FileHeader, file multipart.File, metadata UploadMetadata) (Asset, error) {
	if strings.TrimSpace(metadata.RightsNote) == "" {
		return Asset{}, ValidationError{Fields: map[string]string{"rightsNote": "is required"}}
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

	var asset Asset
	err = s.Pool.QueryRow(ctx, `
		INSERT INTO score_assets(edition_id,asset_type,storage_key,original_filename,media_type,byte_size,sha256,source_url,rights_note,playback_capable,uploaded_by_user_id)
		SELECT e.id,$3,$4,$5,$6,$7,$8,NULLIF($9,''),$10,$11,$1
		FROM editions e JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE lw.user_id=$1 AND e.id=$2
		RETURNING id::text,edition_id::text,asset_type,original_filename,media_type,byte_size,sha256,COALESCE(source_url,''),rights_note,playback_capable,created_at`,
		userID, editionID, format.AssetType, key, header.Filename, format.MediaType, stored.Size, stored.Checksum,
		metadata.SourceURL, metadata.RightsNote, format.AssetType == "musicxml",
	).Scan(&asset.ID, &asset.EditionID, &asset.AssetType, &asset.OriginalFilename, &asset.MediaType, &asset.ByteSize, &asset.SHA256, &asset.SourceURL, &asset.RightsNote, &asset.PlaybackCapable, &asset.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Asset{}, ErrNotFound
	}
	if err != nil {
		return Asset{}, fmt.Errorf("record asset metadata: %w", err)
	}
	cleanup = false
	asset.ContentURL = "/api/assets/" + asset.ID + "/content"
	return asset, nil
}

func (s *Service) ListEditionAssets(ctx context.Context, userID, editionID string) ([]Asset, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT a.id::text,a.edition_id::text,a.asset_type,a.original_filename,a.media_type,a.byte_size,a.sha256,COALESCE(a.source_url,''),a.rights_note,a.playback_capable,a.created_at
		FROM score_assets a JOIN editions e ON e.id=a.edition_id JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE lw.user_id=$1 AND a.uploaded_by_user_id=$1 AND a.edition_id=$2 ORDER BY a.created_at`, userID, editionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Asset{}
	for rows.Next() {
		var item Asset
		if err := rows.Scan(&item.ID, &item.EditionID, &item.AssetType, &item.OriginalFilename, &item.MediaType, &item.ByteSize, &item.SHA256, &item.SourceURL, &item.RightsNote, &item.PlaybackCapable, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.ContentURL = "/api/assets/" + item.ID + "/content"
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) getAssetRecord(ctx context.Context, userID, assetID string) (assetRecord, error) {
	var item assetRecord
	err := s.Pool.QueryRow(ctx, `
		SELECT a.id::text,a.edition_id::text,a.asset_type,a.original_filename,a.media_type,a.byte_size,a.sha256,COALESCE(a.source_url,''),a.rights_note,a.playback_capable,a.created_at,a.storage_key
		FROM score_assets a JOIN editions e ON e.id=a.edition_id JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE lw.user_id=$1 AND a.uploaded_by_user_id=$1 AND a.id=$2`, userID, assetID).Scan(
		&item.ID, &item.EditionID, &item.AssetType, &item.OriginalFilename, &item.MediaType, &item.ByteSize,
		&item.SHA256, &item.SourceURL, &item.RightsNote, &item.PlaybackCapable, &item.CreatedAt, &item.StorageKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return assetRecord{}, ErrNotFound
	}
	item.ContentURL = "/api/assets/" + item.ID + "/content"
	return item, err
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
	item, err := s.getAssetRecord(ctx, userID, assetID)
	if err != nil {
		return err
	}
	result, err := s.Pool.Exec(ctx, `DELETE FROM score_assets WHERE uploaded_by_user_id=$1 AND id=$2`, userID, assetID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := s.Store.Delete(context.Background(), item.StorageKey); err != nil {
		slog.Error("asset metadata deleted but storage cleanup failed", "asset_id", assetID, "storage_key", item.StorageKey, "error", err)
	}
	return nil
}
