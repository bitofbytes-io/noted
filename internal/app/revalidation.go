package app

import (
	"context"
	"errors"
	"fmt"

	assetstore "github.com/bitofbytes-io/noted/internal/assets"
)

type RevalidationSummary struct {
	Checked     int `json:"checked"`
	Ready       int `json:"ready"`
	NeedsReview int `json:"needsReview"`
	Blocked     int `json:"blocked"`
}

func (s *Service) RevalidateMusicXMLAssets(ctx context.Context) (RevalidationSummary, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT id::text,storage_key,original_filename
		FROM score_assets
		WHERE asset_type='musicxml'
		ORDER BY created_at,id`)
	if err != nil {
		return RevalidationSummary{}, err
	}
	type candidate struct {
		id, storageKey, filename string
	}
	candidates := []candidate{}
	for rows.Next() {
		var value candidate
		if err := rows.Scan(&value.id, &value.storageKey, &value.filename); err != nil {
			rows.Close()
			return RevalidationSummary{}, err
		}
		candidates = append(candidates, value)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return RevalidationSummary{}, err
	}
	rows.Close()

	var summary RevalidationSummary
	var validationErrors []error
	for _, candidate := range candidates {
		reader, _, err := s.Store.Open(ctx, candidate.storageKey)
		if err != nil {
			validationErrors = append(validationErrors, fmt.Errorf("open asset %s: %w", candidate.id, err))
			continue
		}
		validation, validationErr := assetstore.ValidateMusicXML(reader, candidate.filename)
		closeErr := reader.Close()
		if validationErr == nil {
			validationErr = closeErr
		}
		if validationErr != nil {
			validationErrors = append(validationErrors, fmt.Errorf("validate asset %s: %w", candidate.id, validationErr))
			continue
		}
		playbackCapable := validation.Status == "ready" || validation.Status == "needs_review"
		if _, err := s.Pool.Exec(ctx, `
			UPDATE score_assets
			SET playback_capable=$2,playback_validation_status=$3,playback_validation_issues=$4,updated_at=now()
			WHERE id=$1`, candidate.id, playbackCapable, validation.Status, validation.Issues); err != nil {
			validationErrors = append(validationErrors, fmt.Errorf("record asset %s validation: %w", candidate.id, err))
			continue
		}
		summary.Checked++
		switch validation.Status {
		case "ready":
			summary.Ready++
		case "needs_review":
			summary.NeedsReview++
		case "blocked":
			summary.Blocked++
		}
	}
	return summary, errors.Join(validationErrors...)
}
