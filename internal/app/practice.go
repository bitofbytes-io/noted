package app

import (
	"context"
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
		if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM score_assets a JOIN editions e ON e.id=a.edition_id WHERE a.id=$1 AND e.work_id=$2)`, *assetID, workID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ValidationError{Fields: map[string]string{"scoreAssetId": "must belong to the selected work"}}
		}
	}
	return nil
}

func (s *Service) StartPractice(ctx context.Context, userID string, input PracticeInput) (PracticeSession, error) {
	if input.WorkID == "" {
		return PracticeSession{}, ValidationError{Fields: map[string]string{"workId": "is required"}}
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
	err := s.Pool.QueryRow(ctx, `SELECT work_id::text,started_at FROM practice_sessions WHERE id=$1 AND user_id=$2 AND ended_at IS NULL`, sessionID, userID).Scan(&workID, &started)
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
	if err := ValidatePractice(duration, input.StartMeasure, input.EndMeasure, input.StartingBPM, input.EndingBPM); err != nil {
		return PracticeSession{}, err
	}
	if err := s.validatePracticeContext(ctx, userID, workID, input.MovementID, input.ScoreAssetID); err != nil {
		return PracticeSession{}, err
	}
	result, err := s.Pool.Exec(ctx, `
		UPDATE practice_sessions SET movement_id=$3,score_asset_id=$4,ended_at=now(),duration_seconds=$5,start_measure=$6,end_measure=$7,hand_part=NULLIF($8,''),
		starting_bpm=$9,ending_bpm=$10,notes=NULLIF($11,''),updated_at=now() WHERE id=$1 AND user_id=$2 AND ended_at IS NULL`,
		sessionID, userID, input.MovementID, input.ScoreAssetID, duration, input.StartMeasure, input.EndMeasure, input.HandPart, input.StartingBPM, input.EndingBPM, input.Notes)
	if err != nil {
		return PracticeSession{}, err
	}
	if result.RowsAffected() == 0 {
		return PracticeSession{}, ErrNotFound
	}
	if input.EndingBPM != nil {
		_, _ = s.Pool.Exec(ctx, `UPDATE learner_works SET last_bpm=$3,updated_at=now() WHERE user_id=$1 AND work_id=$2`, userID, workID, *input.EndingBPM)
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
	bpm := input.EndingBPM
	if bpm == nil {
		bpm = input.StartingBPM
	}
	if bpm != nil {
		_, _ = s.Pool.Exec(ctx, `UPDATE learner_works SET last_bpm=$3,updated_at=now() WHERE user_id=$1 AND work_id=$2`, userID, input.WorkID, *bpm)
	}
	return s.GetPracticeSession(ctx, userID, id)
}

func (s *Service) UpdatePractice(ctx context.Context, userID, sessionID string, input PracticeInput) (PracticeSession, error) {
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
	result, err := s.Pool.Exec(ctx, `
		UPDATE practice_sessions SET work_id=$3,movement_id=$4,score_asset_id=$5,started_at=$6,ended_at=$7,duration_seconds=$8,
		start_measure=$9,end_measure=$10,hand_part=NULLIF($11,''),starting_bpm=$12,ending_bpm=$13,notes=NULLIF($14,''),updated_at=now()
		WHERE id=$1 AND user_id=$2 AND ended_at IS NOT NULL`, sessionID, userID, input.WorkID, input.MovementID, input.ScoreAssetID, started, ended,
		input.DurationSeconds, input.StartMeasure, input.EndMeasure, input.HandPart, input.StartingBPM, input.EndingBPM, input.Notes)
	if err != nil {
		return PracticeSession{}, err
	}
	if result.RowsAffected() == 0 {
		return PracticeSession{}, ErrNotFound
	}
	return s.GetPracticeSession(ctx, userID, sessionID)
}

func (s *Service) DeletePractice(ctx context.Context, userID, sessionID string) error {
	result, err := s.Pool.Exec(ctx, `DELETE FROM practice_sessions WHERE id=$1 AND user_id=$2`, sessionID, userID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
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
	rows, err := s.Pool.Query(ctx, practiceSelect+` WHERE ps.user_id=$1 AND ($2='' OR ps.work_id::text=$2) ORDER BY ps.started_at DESC LIMIT 100`, userID, workID)
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
