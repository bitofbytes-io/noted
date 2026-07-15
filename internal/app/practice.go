package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type PracticeInput struct {
	WorkID          string     `json:"workId"`
	MovementID      *string    `json:"movementId"`
	ScoreAssetID    *string    `json:"scoreAssetId"`
	StartedAt       *time.Time `json:"startedAt"`
	DurationSeconds int        `json:"durationSeconds"`
	StartMeasure    *int       `json:"startMeasure"`
	EndMeasure      *int       `json:"endMeasure"`
	HandPart        string     `json:"handPart"`
	StartingBPM     *int       `json:"startingBpm"`
	EndingBPM       *int       `json:"endingBpm"`
	Notes           string     `json:"notes"`
}

type StopPracticeInput struct {
	MovementID   *string `json:"movementId"`
	ScoreAssetID *string `json:"scoreAssetId"`
	StartMeasure *int    `json:"startMeasure"`
	EndMeasure   *int    `json:"endMeasure"`
	HandPart     string  `json:"handPart"`
	StartingBPM  *int    `json:"startingBpm"`
	EndingBPM    *int    `json:"endingBpm"`
	Notes        string  `json:"notes"`
}

// PatchField distinguishes an omitted PATCH field from an explicit JSON null.
type PatchField[T any] struct {
	Set   bool
	Value *T
}

func (field *PatchField[T]) UnmarshalJSON(data []byte) error {
	field.Set = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		field.Value = nil
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	field.Value = &value
	return nil
}

type PracticePatchInput struct {
	WorkID          PatchField[string]    `json:"workId"`
	MovementID      PatchField[string]    `json:"movementId"`
	ScoreAssetID    PatchField[string]    `json:"scoreAssetId"`
	StartedAt       PatchField[time.Time] `json:"startedAt"`
	DurationSeconds PatchField[int]       `json:"durationSeconds"`
	StartMeasure    PatchField[int]       `json:"startMeasure"`
	EndMeasure      PatchField[int]       `json:"endMeasure"`
	HandPart        PatchField[string]    `json:"handPart"`
	StartingBPM     PatchField[int]       `json:"startingBpm"`
	EndingBPM       PatchField[int]       `json:"endingBpm"`
	Notes           PatchField[string]    `json:"notes"`
}

func (s *Service) validatePracticeContext(ctx context.Context, userID, workID string, movementID, assetID *string) error {
	var exists bool
	if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM learner_works WHERE user_id=$1 AND work_id=$2)`, userID, workID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	if movementID != nil {
		if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM movements WHERE id=$1 AND work_id=$2)`, *movementID, workID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ValidationError{Fields: map[string]string{"movementId": "must belong to the selected work"}}
		}
	}
	if assetID != nil {
		if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM score_assets a JOIN editions e ON e.id=a.edition_id WHERE a.id=$1 AND e.work_id=$2 AND a.uploaded_by_user_id=$3)`, *assetID, workID, userID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
	}
	return nil
}

func (s *Service) StartPractice(ctx context.Context, userID string, input PracticeInput) (PracticeSession, error) {
	if input.WorkID == "" {
		return PracticeSession{}, ValidationError{Fields: map[string]string{"workId": "is required"}}
	}
	if err := ValidatePractice(1, input.StartMeasure, input.EndMeasure, input.StartingBPM, nil); err != nil {
		return PracticeSession{}, err
	}
	if err := s.validatePracticeContext(ctx, userID, input.WorkID, input.MovementID, input.ScoreAssetID); err != nil {
		return PracticeSession{}, err
	}
	var id string
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO practice_sessions(user_id,work_id,movement_id,score_asset_id,started_at,entry_method,start_measure,end_measure,hand_part,starting_bpm,notes)
		VALUES($1,$2,$3,$4,now(),'timer',$5,$6,NULLIF($7,''),$8,NULLIF($9,'')) RETURNING id::text`,
		userID, input.WorkID, input.MovementID, input.ScoreAssetID, input.StartMeasure, input.EndMeasure, input.HandPart, input.StartingBPM, input.Notes).Scan(&id)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.ConstraintName == "one_running_timer_per_user" {
		return PracticeSession{}, ErrConflict
	}
	if err != nil {
		return PracticeSession{}, err
	}
	return s.GetPracticeSession(ctx, userID, id)
}

func (s *Service) StopPractice(ctx context.Context, userID, sessionID string, input StopPracticeInput) (PracticeSession, error) {
	var workID string
	var started time.Time
	var movementID, scoreAssetID *string
	var startMeasure, endMeasure, startingBPM *int
	var handPart, notes string
	err := s.Pool.QueryRow(ctx, `
		SELECT work_id::text,started_at,movement_id::text,score_asset_id::text,start_measure,end_measure,COALESCE(hand_part,''),starting_bpm,COALESCE(notes,'')
		FROM practice_sessions WHERE id=$1 AND user_id=$2 AND ended_at IS NULL`, sessionID, userID).
		Scan(&workID, &started, &movementID, &scoreAssetID, &startMeasure, &endMeasure, &handPart, &startingBPM, &notes)
	if errors.Is(err, pgx.ErrNoRows) {
		return PracticeSession{}, ErrNotFound
	}
	if err != nil {
		return PracticeSession{}, err
	}
	duration := int(time.Since(started).Seconds())
	if duration < 1 {
		duration = 1
	}
	if input.MovementID != nil {
		movementID = input.MovementID
	}
	if input.ScoreAssetID != nil {
		scoreAssetID = input.ScoreAssetID
	}
	if input.StartMeasure != nil {
		startMeasure = input.StartMeasure
	}
	if input.EndMeasure != nil {
		endMeasure = input.EndMeasure
	}
	if input.HandPart != "" {
		handPart = input.HandPart
	}
	if input.StartingBPM != nil {
		startingBPM = input.StartingBPM
	}
	if input.Notes != "" {
		notes = input.Notes
	}
	if err := ValidatePractice(duration, startMeasure, endMeasure, startingBPM, input.EndingBPM); err != nil {
		return PracticeSession{}, err
	}
	if err := s.validatePracticeContext(ctx, userID, workID, movementID, scoreAssetID); err != nil {
		return PracticeSession{}, err
	}
	result, err := s.Pool.Exec(ctx, `
		UPDATE practice_sessions SET movement_id=$3,score_asset_id=$4,ended_at=now(),duration_seconds=$5,start_measure=$6,end_measure=$7,hand_part=NULLIF($8,''),
		starting_bpm=$9,ending_bpm=$10,notes=NULLIF($11,''),updated_at=now() WHERE id=$1 AND user_id=$2 AND ended_at IS NULL`,
		sessionID, userID, movementID, scoreAssetID, duration, startMeasure, endMeasure, handPart, startingBPM, input.EndingBPM, notes)
	if err != nil {
		return PracticeSession{}, err
	}
	if result.RowsAffected() == 0 {
		return PracticeSession{}, ErrNotFound
	}
	if err := s.refreshLastBPM(ctx, userID, workID); err != nil {
		return PracticeSession{}, err
	}
	return s.GetPracticeSession(ctx, userID, sessionID)
}

func (s *Service) CreateManualPractice(ctx context.Context, userID string, input PracticeInput) (PracticeSession, error) {
	if err := ValidatePractice(input.DurationSeconds, input.StartMeasure, input.EndMeasure, input.StartingBPM, input.EndingBPM); err != nil {
		return PracticeSession{}, err
	}
	if err := s.validatePracticeContext(ctx, userID, input.WorkID, input.MovementID, input.ScoreAssetID); err != nil {
		return PracticeSession{}, err
	}
	started := time.Now().UTC().Add(-time.Duration(input.DurationSeconds) * time.Second)
	if input.StartedAt != nil {
		started = input.StartedAt.UTC()
	}
	ended := started.Add(time.Duration(input.DurationSeconds) * time.Second)
	var id string
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO practice_sessions(user_id,work_id,movement_id,score_asset_id,started_at,ended_at,duration_seconds,entry_method,start_measure,end_measure,hand_part,starting_bpm,ending_bpm,notes)
		VALUES($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,NULLIF($10,''),$11,$12,NULLIF($13,'')) RETURNING id::text`,
		userID, input.WorkID, input.MovementID, input.ScoreAssetID, started, ended, input.DurationSeconds, input.StartMeasure, input.EndMeasure, input.HandPart, input.StartingBPM, input.EndingBPM, input.Notes).Scan(&id)
	if err != nil {
		return PracticeSession{}, err
	}
	if err := s.refreshLastBPM(ctx, userID, input.WorkID); err != nil {
		return PracticeSession{}, err
	}
	return s.GetPracticeSession(ctx, userID, id)
}

func (s *Service) UpdatePractice(ctx context.Context, userID, sessionID string, patch PracticePatchInput) (PracticeSession, error) {
	existing, err := s.GetPracticeSession(ctx, userID, sessionID)
	if err != nil {
		return PracticeSession{}, err
	}
	if existing.EndedAt == nil {
		return PracticeSession{}, ErrNotFound
	}

	workID := existing.WorkID
	movementID := existing.MovementID
	scoreAssetID := existing.ScoreAssetID
	started := existing.StartedAt
	duration := existing.DurationSeconds
	startMeasure := existing.StartMeasure
	endMeasure := existing.EndMeasure
	handPart := existing.HandPart
	startingBPM := existing.StartingBPM
	endingBPM := existing.EndingBPM
	notes := existing.Notes

	if patch.WorkID.Set {
		if patch.WorkID.Value == nil || *patch.WorkID.Value == "" {
			return PracticeSession{}, ValidationError{Fields: map[string]string{"workId": "is required"}}
		}
		workID = *patch.WorkID.Value
	}
	if patch.MovementID.Set {
		movementID = patch.MovementID.Value
	}
	if patch.ScoreAssetID.Set {
		scoreAssetID = patch.ScoreAssetID.Value
	}
	if patch.StartedAt.Set {
		if patch.StartedAt.Value == nil {
			return PracticeSession{}, ValidationError{Fields: map[string]string{"startedAt": "cannot be null"}}
		}
		started = patch.StartedAt.Value.UTC()
	}
	if patch.DurationSeconds.Set {
		if patch.DurationSeconds.Value == nil {
			return PracticeSession{}, ValidationError{Fields: map[string]string{"durationSeconds": "cannot be null"}}
		}
		duration = *patch.DurationSeconds.Value
	}
	if patch.StartMeasure.Set {
		startMeasure = patch.StartMeasure.Value
	}
	if patch.EndMeasure.Set {
		endMeasure = patch.EndMeasure.Value
	}
	if patch.HandPart.Set {
		handPart = ""
		if patch.HandPart.Value != nil {
			handPart = *patch.HandPart.Value
		}
	}
	if patch.StartingBPM.Set {
		startingBPM = patch.StartingBPM.Value
	}
	if patch.EndingBPM.Set {
		endingBPM = patch.EndingBPM.Value
	}
	if patch.Notes.Set {
		notes = ""
		if patch.Notes.Value != nil {
			notes = *patch.Notes.Value
		}
	}

	if err := ValidatePractice(duration, startMeasure, endMeasure, startingBPM, endingBPM); err != nil {
		return PracticeSession{}, err
	}
	if err := s.validatePracticeContext(ctx, userID, workID, movementID, scoreAssetID); err != nil {
		return PracticeSession{}, err
	}
	ended := started.Add(time.Duration(duration) * time.Second)
	result, err := s.Pool.Exec(ctx, `
		UPDATE practice_sessions SET work_id=$3,movement_id=$4,score_asset_id=$5,started_at=$6,ended_at=$7,duration_seconds=$8,
		start_measure=$9,end_measure=$10,hand_part=NULLIF($11,''),starting_bpm=$12,ending_bpm=$13,notes=NULLIF($14,''),updated_at=now()
		WHERE id=$1 AND user_id=$2 AND ended_at IS NOT NULL`, sessionID, userID, workID, movementID, scoreAssetID, started, ended,
		duration, startMeasure, endMeasure, handPart, startingBPM, endingBPM, notes)
	if err != nil {
		return PracticeSession{}, err
	}
	if result.RowsAffected() == 0 {
		return PracticeSession{}, ErrNotFound
	}
	if err := s.refreshLastBPM(ctx, userID, existing.WorkID, workID); err != nil {
		return PracticeSession{}, err
	}
	return s.GetPracticeSession(ctx, userID, sessionID)
}

func (s *Service) DeletePractice(ctx context.Context, userID, sessionID string) error {
	existing, err := s.GetPracticeSession(ctx, userID, sessionID)
	if err != nil {
		return err
	}
	result, err := s.Pool.Exec(ctx, `DELETE FROM practice_sessions WHERE id=$1 AND user_id=$2`, sessionID, userID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return s.refreshLastBPM(ctx, userID, existing.WorkID)
}

func (s *Service) refreshLastBPM(ctx context.Context, userID string, workIDs ...string) error {
	seen := make(map[string]struct{}, len(workIDs))
	for _, workID := range workIDs {
		if workID == "" {
			continue
		}
		if _, ok := seen[workID]; ok {
			continue
		}
		seen[workID] = struct{}{}
		if _, err := s.Pool.Exec(ctx, `
			UPDATE learner_works SET last_bpm=(
				SELECT COALESCE(ps.ending_bpm,ps.starting_bpm) FROM practice_sessions ps
				WHERE ps.user_id=$1 AND ps.work_id=$2 AND ps.ended_at IS NOT NULL
				  AND COALESCE(ps.ending_bpm,ps.starting_bpm) IS NOT NULL
				ORDER BY ps.started_at DESC,ps.created_at DESC LIMIT 1
			),updated_at=now() WHERE user_id=$1 AND work_id=$2`, userID, workID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) GetPracticeSession(ctx context.Context, userID, sessionID string) (PracticeSession, error) {
	row := s.Pool.QueryRow(ctx, practiceSelect+` WHERE ps.user_id=$1 AND ps.id=$2`, userID, sessionID)
	item, err := scanPractice(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return PracticeSession{}, ErrNotFound
	}
	return item, err
}

func (s *Service) ListPractice(ctx context.Context, userID, workID string) ([]PracticeSession, error) {
	rows, err := s.Pool.Query(ctx, practiceSelect+` WHERE ps.user_id=$1 AND ($2='' OR ps.work_id::text=$2)
		ORDER BY (ps.ended_at IS NULL) DESC, ps.started_at DESC LIMIT 100`, userID, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []PracticeSession{}
	for rows.Next() {
		item, err := scanPractice(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

const practiceSelect = `
	SELECT ps.id::text,ps.work_id::text,w.title,ps.movement_id::text,ps.score_asset_id::text,ps.started_at,ps.ended_at,
	       ps.duration_seconds,ps.entry_method,ps.start_measure,ps.end_measure,COALESCE(ps.hand_part,''),ps.starting_bpm,ps.ending_bpm,COALESCE(ps.notes,'')
	FROM practice_sessions ps JOIN works w ON w.id=ps.work_id`

type scanner interface{ Scan(...any) error }

func scanPractice(row scanner) (PracticeSession, error) {
	var item PracticeSession
	err := row.Scan(&item.ID, &item.WorkID, &item.WorkTitle, &item.MovementID, &item.ScoreAssetID, &item.StartedAt, &item.EndedAt,
		&item.DurationSeconds, &item.EntryMethod, &item.StartMeasure, &item.EndMeasure, &item.HandPart, &item.StartingBPM, &item.EndingBPM, &item.Notes)
	if err != nil {
		return PracticeSession{}, fmt.Errorf("scan practice session: %w", err)
	}
	return item, nil
}
