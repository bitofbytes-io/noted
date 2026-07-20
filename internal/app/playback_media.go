package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

var youtubeVideoIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

type MediaLinkInput struct {
	Kind    string `json:"kind"`
	URL     string `json:"url"`
	VideoID string `json:"videoId"`
	Title   string `json:"title"`
}

func normalizeYouTubeVideoID(input MediaLinkInput) (string, error) {
	value := strings.TrimSpace(input.VideoID)
	if value == "" {
		value = strings.TrimSpace(input.URL)
	}
	if youtubeVideoIDPattern.MatchString(value) {
		return value, nil
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", ValidationError{Fields: map[string]string{"url": "must be a YouTube URL or video ID"}}
	}
	host := strings.ToLower(strings.TrimPrefix(parsed.Hostname(), "www."))
	switch host {
	case "youtu.be":
		value = strings.Trim(strings.Split(strings.Trim(parsed.Path, "/"), "/")[0], " ")
	case "youtube.com", "m.youtube.com", "music.youtube.com":
		value = parsed.Query().Get("v")
		if value == "" {
			parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
			if len(parts) == 2 && (parts[0] == "embed" || parts[0] == "shorts") {
				value = parts[1]
			}
		}
	default:
		value = ""
	}
	if !youtubeVideoIDPattern.MatchString(value) {
		return "", ValidationError{Fields: map[string]string{"url": "must be a valid YouTube video URL"}}
	}
	return value, nil
}

func (s *Service) CreateMediaLink(ctx context.Context, userID, editionID string, input MediaLinkInput) (MediaLink, error) {
	if err := validateResourceID(editionID); err != nil {
		return MediaLink{}, err
	}
	if input.Kind == "" {
		input.Kind = "youtube"
	}
	if input.Kind != "youtube" {
		return MediaLink{}, ValidationError{Fields: map[string]string{"kind": "must be youtube"}}
	}
	videoID, err := normalizeYouTubeVideoID(input)
	if err != nil {
		return MediaLink{}, err
	}
	title := strings.TrimSpace(input.Title)
	if len(title) > 300 {
		return MediaLink{}, ValidationError{Fields: map[string]string{"title": "must be 300 characters or fewer"}}
	}
	var item MediaLink
	err = s.Pool.QueryRow(ctx, `
		INSERT INTO media_links(user_id,edition_id,kind,video_id,title)
		SELECT $1,e.id,'youtube',$3,$4
		FROM editions e JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE e.id=$2 AND lw.user_id=$1 AND e.archived_at IS NULL
		ON CONFLICT (user_id,edition_id,kind,video_id) DO UPDATE SET title=EXCLUDED.title,updated_at=now()
		RETURNING id::text,edition_id::text,kind,video_id,title,0,created_at`, userID, editionID, videoID, title,
	).Scan(&item.ID, &item.EditionID, &item.Kind, &item.VideoID, &item.Title, &item.AnchorCount, &item.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return MediaLink{}, ErrNotFound
	}
	return item, err
}

func (s *Service) ListMediaLinks(ctx context.Context, userID, editionID string) ([]MediaLink, error) {
	if err := validateResourceID(editionID); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT ml.id::text,ml.edition_id::text,ml.kind,ml.video_id,ml.title,
		       (SELECT count(*) FROM measure_anchors ma WHERE ma.media_link_id=ml.id)::int,ml.created_at
		FROM media_links ml JOIN editions e ON e.id=ml.edition_id JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE ml.user_id=$1 AND lw.user_id=$1 AND ml.edition_id=$2 ORDER BY ml.created_at`, userID, editionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []MediaLink{}
	for rows.Next() {
		var item MediaLink
		if err := rows.Scan(&item.ID, &item.EditionID, &item.Kind, &item.VideoID, &item.Title, &item.AnchorCount, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) DeleteMediaLink(ctx context.Context, userID, mediaLinkID string) error {
	if err := validateResourceID(mediaLinkID); err != nil {
		return err
	}
	result, err := s.Pool.Exec(ctx, `DELETE FROM media_links WHERE id=$2 AND user_id=$1`, userID, mediaLinkID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

type AnchorInput struct {
	MeasureNumber int   `json:"measureNumber"`
	PositionMS    int64 `json:"positionMs"`
}

func validateAnchors(anchors []AnchorInput) error {
	if len(anchors) > 10000 {
		return ValidationError{Fields: map[string]string{"anchors": "must contain at most 10000 entries"}}
	}
	seen := map[int]bool{}
	for _, anchor := range anchors {
		if anchor.MeasureNumber < 1 || anchor.PositionMS < 0 || anchor.PositionMS > 86400000 {
			return ValidationError{Fields: map[string]string{"anchors": "measure numbers must be positive and positions must be between 0 and 24 hours"}}
		}
		if seen[anchor.MeasureNumber] {
			return ValidationError{Fields: map[string]string{"anchors": "measure numbers must be unique"}}
		}
		seen[anchor.MeasureNumber] = true
	}
	return nil
}

func (s *Service) listAnchors(ctx context.Context, userID, targetColumn, targetID string) ([]MeasureAnchor, error) {
	if err := validateResourceID(targetID); err != nil {
		return nil, err
	}
	ownership := `EXISTS(SELECT 1 FROM media_links ml WHERE ml.id=$2 AND ml.user_id=$1)`
	if targetColumn == "asset_id" {
		ownership = `EXISTS(SELECT 1 FROM score_assets a JOIN editions e ON e.id=a.edition_id JOIN learner_works lw ON lw.work_id=e.work_id WHERE a.id=$2 AND a.uploaded_by_user_id=$1 AND lw.user_id=$1)`
	}
	var owned bool
	if err := s.Pool.QueryRow(ctx, `SELECT `+ownership, userID, targetID).Scan(&owned); err != nil {
		return nil, err
	}
	if !owned {
		return nil, ErrNotFound
	}
	rows, err := s.Pool.Query(ctx, `SELECT id::text,measure_number,position_ms FROM measure_anchors WHERE user_id=$1 AND `+targetColumn+`=$2 ORDER BY measure_number`, userID, targetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []MeasureAnchor{}
	for rows.Next() {
		var item MeasureAnchor
		if err := rows.Scan(&item.ID, &item.MeasureNumber, &item.PositionMS); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) replaceAnchors(ctx context.Context, userID, targetColumn, targetID string, anchors []AnchorInput) ([]MeasureAnchor, error) {
	if err := validateAnchors(anchors); err != nil {
		return nil, err
	}
	if _, err := s.listAnchors(ctx, userID, targetColumn, targetID); err != nil {
		return nil, err
	}
	sort.Slice(anchors, func(i, j int) bool { return anchors[i].MeasureNumber < anchors[j].MeasureNumber })
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `DELETE FROM measure_anchors WHERE user_id=$1 AND `+targetColumn+`=$2`, userID, targetID); err != nil {
		return nil, err
	}
	for _, anchor := range anchors {
		query := `INSERT INTO measure_anchors(user_id,media_link_id,measure_number,position_ms) VALUES($1,$2,$3,$4)`
		if targetColumn == "asset_id" {
			query = `INSERT INTO measure_anchors(user_id,asset_id,measure_number,position_ms) VALUES($1,$2,$3,$4)`
		}
		if _, err := tx.Exec(ctx, query, userID, targetID, anchor.MeasureNumber, anchor.PositionMS); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.listAnchors(ctx, userID, targetColumn, targetID)
}

func (s *Service) ListMediaLinkAnchors(ctx context.Context, userID, id string) ([]MeasureAnchor, error) {
	return s.listAnchors(ctx, userID, "media_link_id", id)
}
func (s *Service) ReplaceMediaLinkAnchors(ctx context.Context, userID, id string, anchors []AnchorInput) ([]MeasureAnchor, error) {
	return s.replaceAnchors(ctx, userID, "media_link_id", id, anchors)
}
func (s *Service) ListAssetAnchors(ctx context.Context, userID, id string) ([]MeasureAnchor, error) {
	return s.listAnchors(ctx, userID, "asset_id", id)
}
func (s *Service) ReplaceAssetAnchors(ctx context.Context, userID, id string, anchors []AnchorInput) ([]MeasureAnchor, error) {
	return s.replaceAnchors(ctx, userID, "asset_id", id, anchors)
}

func (s *Service) GetMeasureMap(ctx context.Context, userID, assetID string) (MeasureMap, error) {
	if err := validateResourceID(assetID); err != nil {
		return MeasureMap{}, err
	}
	var item MeasureMap
	var pagesJSON []byte
	err := s.Pool.QueryRow(ctx, `
		SELECT mm.asset_id::text,mm.status,mm.pages,mm.engine_version,COALESCE(mm.failure_message,''),mm.updated_at
		FROM measure_maps mm JOIN score_assets a ON a.id=mm.asset_id JOIN editions e ON e.id=a.edition_id JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE mm.user_id=$1 AND a.uploaded_by_user_id=$1 AND lw.user_id=$1 AND mm.asset_id=$2`, userID, assetID,
	).Scan(&item.AssetID, &item.Status, &pagesJSON, &item.EngineVersion, &item.FailureMessage, &item.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return MeasureMap{}, ErrNotFound
	}
	if err != nil {
		return MeasureMap{}, err
	}
	if err := json.Unmarshal(pagesJSON, &item.Pages); err != nil {
		return MeasureMap{}, err
	}
	return item, nil
}
