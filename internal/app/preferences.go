package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

func (s *Service) GetPreferences(ctx context.Context, userID string) (Preferences, error) {
	var preferences Preferences
	err := s.pool.QueryRow(ctx, `SELECT library_filter, library_sort FROM users WHERE id=$1`, userID).
		Scan(&preferences.LibraryFilter, &preferences.LibrarySort)
	if errors.Is(err, pgx.ErrNoRows) {
		return Preferences{}, ErrNotFound
	}
	return preferences, err
}

// PutPreferences saves the preferences the patch sets and keeps the others.
func (s *Service) PutPreferences(
	ctx context.Context,
	userID string,
	patch PreferencesPatch,
) (Preferences, error) {
	if err := validatePreferences(patch); err != nil {
		return Preferences{}, err
	}
	var preferences Preferences
	err := s.pool.QueryRow(ctx, `
		UPDATE users SET
			library_filter=COALESCE($2, library_filter),
			library_sort=COALESCE($3, library_sort)
		WHERE id=$1 RETURNING library_filter, library_sort`,
		userID, patch.LibraryFilter, patch.LibrarySort,
	).Scan(&preferences.LibraryFilter, &preferences.LibrarySort)
	if errors.Is(err, pgx.ErrNoRows) {
		return Preferences{}, ErrNotFound
	}
	return preferences, err
}
