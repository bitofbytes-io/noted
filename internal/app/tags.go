package app

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Tag struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (s *Service) ListTags(ctx context.Context, userID string) ([]Tag, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id::text,name FROM tags WHERE user_id=$1 ORDER BY normalized_name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Tag{}
	for rows.Next() {
		var tag Tag
		if err := rows.Scan(&tag.ID, &tag.Name); err != nil {
			return nil, err
		}
		items = append(items, tag)
	}
	return items, rows.Err()
}

func (s *Service) CreateTag(ctx context.Context, userID, name string) (Tag, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 40 {
		return Tag{}, ValidationError{Fields: map[string]string{"name": "must be between 1 and 40 characters"}}
	}
	var tag Tag
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO tags(user_id,name,normalized_name) VALUES($1,$2,lower($2))
		ON CONFLICT(user_id,normalized_name) DO UPDATE SET name=EXCLUDED.name
		RETURNING id::text,name`, userID, name).Scan(&tag.ID, &tag.Name)
	return tag, err
}

func (s *Service) ReplaceWorkTags(ctx context.Context, userID, workID string, tagIDs []string) ([]Tag, error) {
	if err := validateResourceID(workID); err != nil {
		return nil, err
	}
	for _, tagID := range tagIDs {
		if err := uuid.Validate(tagID); err != nil {
			return nil, ValidationError{Fields: map[string]string{"tagIds": "must contain valid tag IDs"}}
		}
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var learnerWorkID string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM learner_works WHERE user_id=$1 AND work_id=$2`, userID, workID).Scan(&learnerWorkID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM learner_work_tags WHERE learner_work_id=$1`, learnerWorkID); err != nil {
		return nil, err
	}
	for _, tagID := range tagIDs {
		result, err := tx.Exec(ctx, `
			INSERT INTO learner_work_tags(learner_work_id,tag_id)
			SELECT $1,id FROM tags WHERE id=$2 AND user_id=$3 ON CONFLICT DO NOTHING`, learnerWorkID, tagID, userID)
		if err != nil {
			return nil, err
		}
		if result.RowsAffected() == 0 {
			return nil, ErrNotAuthorized
		}
	}
	rows, err := tx.Query(ctx, `
		SELECT t.id::text,t.name FROM learner_work_tags lwt JOIN tags t ON t.id=lwt.tag_id
		WHERE lwt.learner_work_id=$1 ORDER BY t.normalized_name`, learnerWorkID)
	if err != nil {
		return nil, err
	}
	items := make([]Tag, 0, len(tagIDs))
	for rows.Next() {
		var tag Tag
		if err := rows.Scan(&tag.ID, &tag.Name); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, tag)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return items, nil
}
