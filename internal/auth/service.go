package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	SessionCookieName = "noted_session"
	StateCookieName   = "noted_oauth_state"
	stateLifetime     = 10 * time.Minute
)

var (
	ErrNotAuthenticated = errors.New("not authenticated")
	ErrInvalidState     = errors.New("invalid oauth state")
	ErrEmailNotAllowed  = errors.New("email is not allowed")
	ErrIdentityConflict = errors.New("google identity conflicts with an existing user")
)

type Service struct {
	Pool          *pgxpool.Pool
	AllowedEmails map[string]struct{}
	SessionTTL    time.Duration
	Now           func() time.Time
}

type GoogleIdentity struct {
	Subject     string
	Email       string
	DisplayName string
	AvatarURL   string
	Verified    bool
}

func NewService(pool *pgxpool.Pool, allowedEmails []string, sessionTTL time.Duration) *Service {
	allowed := make(map[string]struct{}, len(allowedEmails))
	for _, email := range allowedEmails {
		allowed[normalizeEmail(email)] = struct{}{}
	}
	return &Service{Pool: pool, AllowedEmails: allowed, SessionTTL: sessionTTL, Now: time.Now}
}

func (s *Service) NewLoginState(ctx context.Context, returnPath string) (string, error) {
	returnPath = SafeReturnPath(returnPath)
	value, err := randomToken()
	if err != nil {
		return "", err
	}
	hash := tokenHash(value)
	now := s.Now().UTC()
	if _, err := s.Pool.Exec(ctx, `DELETE FROM oauth_login_states WHERE expires_at <= $1`, now); err != nil {
		return "", fmt.Errorf("clean expired oauth states: %w", err)
	}
	if _, err := s.Pool.Exec(ctx, `INSERT INTO oauth_login_states(state_hash,return_path,expires_at) VALUES($1,$2,$3)`,
		hash[:], returnPath, now.Add(stateLifetime)); err != nil {
		return "", fmt.Errorf("store oauth state: %w", err)
	}
	return value, nil
}

func (s *Service) ConsumeLoginState(ctx context.Context, value string) (string, error) {
	if value == "" {
		return "", ErrInvalidState
	}
	hash := tokenHash(value)
	var returnPath string
	err := s.Pool.QueryRow(ctx, `
		DELETE FROM oauth_login_states
		WHERE state_hash=$1 AND expires_at>$2
		RETURNING return_path`, hash[:], s.Now().UTC()).Scan(&returnPath)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrInvalidState
	}
	if err != nil {
		return "", fmt.Errorf("consume oauth state: %w", err)
	}
	return SafeReturnPath(returnPath), nil
}

func (s *Service) AuthenticateGoogle(ctx context.Context, identity GoogleIdentity) (app.User, error) {
	email := normalizeEmail(identity.Email)
	if !s.allowsGoogleIdentity(identity) {
		return app.User{}, ErrEmailNotAllowed
	}
	displayName := strings.TrimSpace(identity.DisplayName)
	if displayName == "" {
		displayName = email
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return app.User{}, fmt.Errorf("begin google authentication: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var user app.User
	err = tx.QueryRow(ctx, `
		UPDATE users SET email=$1,display_name=$2,avatar_url=NULLIF($3,''),last_login_at=$5,updated_at=$5
		WHERE auth_provider='google' AND auth_subject=$4
		RETURNING id::text,email,display_name,week_starts_on,metronome_bpm,metronome_accent`,
		email, displayName, strings.TrimSpace(identity.AvatarURL), identity.Subject, s.Now().UTC()).Scan(
		&user.ID, &user.Email, &user.DisplayName, &user.WeekStartsOn, &user.MetronomeBPM, &user.MetronomeAccent)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `
		INSERT INTO users(email,display_name,avatar_url,auth_provider,auth_subject,last_login_at)
		VALUES($1,$2,NULLIF($3,''),'google',$4,$5)
		ON CONFLICT(email) DO UPDATE SET
			display_name=EXCLUDED.display_name,
			avatar_url=EXCLUDED.avatar_url,
			auth_provider='google',
			auth_subject=EXCLUDED.auth_subject,
			last_login_at=EXCLUDED.last_login_at,
			updated_at=EXCLUDED.last_login_at
		WHERE users.auth_provider='development'
		   OR (users.auth_provider='google' AND (users.auth_subject IS NULL OR users.auth_subject=EXCLUDED.auth_subject))
		RETURNING id::text,email,display_name,week_starts_on,metronome_bpm,metronome_accent`,
			email, displayName, strings.TrimSpace(identity.AvatarURL), identity.Subject, s.Now().UTC()).Scan(
			&user.ID, &user.Email, &user.DisplayName, &user.WeekStartsOn, &user.MetronomeBPM, &user.MetronomeAccent)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return app.User{}, ErrIdentityConflict
	}
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) && databaseError.Code == "23505" {
		return app.User{}, ErrIdentityConflict
	}
	if err != nil {
		return app.User{}, fmt.Errorf("upsert google user: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return app.User{}, fmt.Errorf("commit google authentication: %w", err)
	}
	return user, nil
}

func (s *Service) allowsGoogleIdentity(identity GoogleIdentity) bool {
	if !identity.Verified || strings.TrimSpace(identity.Subject) == "" {
		return false
	}
	_, ok := s.AllowedEmails[normalizeEmail(identity.Email)]
	return ok
}

func (s *Service) NewSession(ctx context.Context, userID, userAgent, remoteAddress string) (string, time.Time, error) {
	value, err := randomToken()
	if err != nil {
		return "", time.Time{}, err
	}
	hash := tokenHash(value)
	now := s.Now().UTC()
	expiresAt := now.Add(s.SessionTTL)
	userAgent = truncate(strings.TrimSpace(userAgent), 512)
	var address any
	if parsed, err := netip.ParseAddr(strings.TrimSpace(remoteAddress)); err == nil {
		address = parsed.String()
	}
	if _, err := s.Pool.Exec(ctx, `DELETE FROM user_sessions WHERE expires_at <= $1`, now); err != nil {
		return "", time.Time{}, fmt.Errorf("clean expired sessions: %w", err)
	}
	if _, err := s.Pool.Exec(ctx, `
		INSERT INTO user_sessions(user_id,token_hash,expires_at,user_agent,ip_address)
		VALUES($1,$2,$3,$4,$5)`, userID, hash[:], expiresAt, userAgent, address); err != nil {
		return "", time.Time{}, fmt.Errorf("create session: %w", err)
	}
	return value, expiresAt, nil
}

func (s *Service) ResolveSession(ctx context.Context, value string) (app.User, error) {
	if value == "" {
		return app.User{}, ErrNotAuthenticated
	}
	hash := tokenHash(value)
	var user app.User
	err := s.Pool.QueryRow(ctx, `
		UPDATE user_sessions s SET last_seen_at=$2
		FROM users u
		WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.id=s.user_id
		RETURNING u.id::text,u.email,u.display_name,u.week_starts_on,u.metronome_bpm,u.metronome_accent`,
		hash[:], s.Now().UTC()).Scan(&user.ID, &user.Email, &user.DisplayName, &user.WeekStartsOn, &user.MetronomeBPM, &user.MetronomeAccent)
	if errors.Is(err, pgx.ErrNoRows) {
		return app.User{}, ErrNotAuthenticated
	}
	if err != nil {
		return app.User{}, fmt.Errorf("resolve session: %w", err)
	}
	return user, nil
}

func (s *Service) DeleteSession(ctx context.Context, value string) error {
	if value == "" {
		return nil
	}
	hash := tokenHash(value)
	if _, err := s.Pool.Exec(ctx, `DELETE FROM user_sessions WHERE token_hash=$1`, hash[:]); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

func SafeReturnPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.ContainsAny(value, "\r\n") {
		return "/"
	}
	return value
}

func normalizeEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func randomToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate secure token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func tokenHash(value string) [32]byte {
	return sha256.Sum256([]byte(value))
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
