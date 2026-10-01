package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/jackc/pgx/v5"
)

// ShortcutTokenStatus describes a user's Send to Noted token without the token.
type ShortcutTokenStatus struct {
	Active     bool       `json:"active"`
	CreatedAt  *time.Time `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
}

// ShortcutTokenStatus never reads or returns the token itself: only its hash is stored.
func (s *Service) ShortcutTokenStatus(ctx context.Context, userID string) (ShortcutTokenStatus, error) {
	var status ShortcutTokenStatus
	err := s.pool.QueryRow(ctx, `
		SELECT created_at,last_used_at FROM shortcut_tokens WHERE user_id=$1`, userID,
	).Scan(&status.CreatedAt, &status.LastUsedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ShortcutTokenStatus{}, nil
	}
	if err != nil {
		return ShortcutTokenStatus{}, fmt.Errorf("read shortcut token: %w", err)
	}
	status.Active = true
	return status, nil
}

// CreateShortcutToken issues the user's one shortcut token, replacing any
// earlier one, and returns the plaintext. It is never retrievable again.
func (s *Service) CreateShortcutToken(ctx context.Context, userID string) (string, time.Time, error) {
	value, err := randomToken()
	if err != nil {
		return "", time.Time{}, err
	}
	hash := tokenHash(value)
	createdAt := s.now().UTC()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("begin shortcut token: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM shortcut_tokens WHERE user_id=$1`, userID); err != nil {
		return "", time.Time{}, fmt.Errorf("replace shortcut token: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO shortcut_tokens(user_id,token_hash,created_at) VALUES($1,$2,$3)`,
		userID, hash[:], createdAt); err != nil {
		return "", time.Time{}, fmt.Errorf("create shortcut token: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", time.Time{}, fmt.Errorf("commit shortcut token: %w", err)
	}
	return value, createdAt, nil
}

func (s *Service) DeleteShortcutToken(ctx context.Context, userID string) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM shortcut_tokens WHERE user_id=$1`, userID); err != nil {
		return fmt.Errorf("delete shortcut token: %w", err)
	}
	return nil
}

// ResolveShortcutToken returns the owner of a presented shortcut token. The
// caller still decides whether that owner may use Noted.
func (s *Service) ResolveShortcutToken(ctx context.Context, value string) (app.User, error) {
	if value == "" {
		return app.User{}, ErrNotAuthenticated
	}
	hash := tokenHash(value)
	var stored []byte
	var user app.User
	err := s.pool.QueryRow(ctx, `
		SELECT t.token_hash,u.id::text,u.email,u.display_name,COALESCE(u.avatar_url,'')
		FROM shortcut_tokens t JOIN users u ON u.id=t.user_id
		WHERE t.token_hash=$1`, hash[:],
	).Scan(&stored, &user.ID, &user.Email, &user.DisplayName, &user.AvatarURL)
	if errors.Is(err, pgx.ErrNoRows) {
		return app.User{}, ErrNotAuthenticated
	}
	if err != nil {
		return app.User{}, fmt.Errorf("resolve shortcut token: %w", err)
	}
	if subtle.ConstantTimeCompare(stored, hash[:]) != 1 {
		return app.User{}, ErrNotAuthenticated
	}
	return user, nil
}

// TouchShortcutToken records that this token was just used. It matches the
// token rather than the user so a use racing a replacement never marks the new token.
func (s *Service) TouchShortcutToken(ctx context.Context, value string) error {
	hash := tokenHash(value)
	if _, err := s.pool.Exec(ctx, `
		UPDATE shortcut_tokens SET last_used_at=$2 WHERE token_hash=$1`, hash[:], s.now().UTC()); err != nil {
		return fmt.Errorf("record shortcut token use: %w", err)
	}
	return nil
}
