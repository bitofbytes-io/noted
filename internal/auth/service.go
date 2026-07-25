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
	"github.com/google/uuid"
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

type GoogleIdentity struct {
	Subject     string
	Email       string
	DisplayName string
	AvatarURL   string
	Verified    bool
}

type Service struct {
	pool          *pgxpool.Pool
	allowedEmails map[string]struct{}
	sessionTTL    time.Duration
	now           func() time.Time
}

func NewService(pool *pgxpool.Pool, allowedEmails []string, sessionTTL time.Duration) *Service {
	allowed := make(map[string]struct{}, len(allowedEmails))
	for _, email := range allowedEmails {
		allowed[normalizeEmail(email)] = struct{}{}
	}
	return &Service{
		pool: pool, allowedEmails: allowed, sessionTTL: sessionTTL, now: time.Now,
	}
}

func (s *Service) EnsureDevelopmentUser(ctx context.Context, email string) (app.User, error) {
	email = normalizeEmail(email)
	displayName := "Local learner"
	var user app.User
	err := s.pool.QueryRow(ctx, `
		INSERT INTO users (id,email,display_name,auth_provider)
		VALUES ($1,$2,$3,'development')
		ON CONFLICT(email) DO UPDATE SET updated_at=users.updated_at
		RETURNING id::text,email,display_name,COALESCE(avatar_url,'')`,
		uuid.NewString(), email, displayName,
	).Scan(&user.ID, &user.Email, &user.DisplayName, &user.AvatarURL)
	return user, err
}

func (s *Service) NewLoginState(ctx context.Context, returnPath string) (string, error) {
	returnPath = SafeReturnPath(returnPath)
	value, err := randomToken()
	if err != nil {
		return "", err
	}
	hash := tokenHash(value)
	now := s.now().UTC()
	if _, err := s.pool.Exec(ctx, `DELETE FROM oauth_login_states WHERE expires_at <= $1`, now); err != nil {
		return "", fmt.Errorf("clean expired oauth states: %w", err)
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO oauth_login_states(state_hash,return_path,expires_at)
		VALUES($1,$2,$3)`, hash[:], returnPath, now.Add(stateLifetime)); err != nil {
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
	err := s.pool.QueryRow(ctx, `
		DELETE FROM oauth_login_states
		WHERE state_hash=$1 AND expires_at>$2
		RETURNING return_path`, hash[:], s.now().UTC()).Scan(&returnPath)
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
	if !identity.Verified || strings.TrimSpace(identity.Subject) == "" {
		return app.User{}, ErrEmailNotAllowed
	}
	if _, allowed := s.allowedEmails[email]; !allowed {
		return app.User{}, ErrEmailNotAllowed
	}
	displayName := strings.TrimSpace(identity.DisplayName)
	if displayName == "" {
		displayName = email
	}
	now := s.now().UTC()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return app.User{}, fmt.Errorf("begin google authentication: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var user app.User
	err = scanUser(tx.QueryRow(ctx, `
		UPDATE users SET email=$1,display_name=$2,avatar_url=NULLIF($3,''),
			last_login_at=$5,updated_at=$5
		WHERE auth_provider='google' AND auth_subject=$4
		RETURNING id::text,email,display_name,COALESCE(avatar_url,'')`,
		email, displayName, strings.TrimSpace(identity.AvatarURL), identity.Subject, now), &user)
	if errors.Is(err, pgx.ErrNoRows) {
		err = scanUser(tx.QueryRow(ctx, `
			INSERT INTO users(id,email,display_name,avatar_url,auth_provider,auth_subject,last_login_at)
			VALUES($1,$2,$3,NULLIF($4,''),'google',$5,$6)
			ON CONFLICT(email) DO UPDATE SET
				display_name=EXCLUDED.display_name,
				avatar_url=EXCLUDED.avatar_url,
				auth_provider='google',
				auth_subject=EXCLUDED.auth_subject,
				last_login_at=EXCLUDED.last_login_at,
				updated_at=EXCLUDED.last_login_at
			WHERE users.auth_provider='development'
			   OR (users.auth_provider='google' AND
			       (users.auth_subject IS NULL OR users.auth_subject=EXCLUDED.auth_subject))
			RETURNING id::text,email,display_name,COALESCE(avatar_url,'')`,
			uuid.NewString(), email, displayName, strings.TrimSpace(identity.AvatarURL),
			identity.Subject, now), &user)
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

func (s *Service) NewSession(
	ctx context.Context,
	userID, userAgent, remoteAddress string,
) (string, time.Time, error) {
	value, err := randomToken()
	if err != nil {
		return "", time.Time{}, err
	}
	hash := tokenHash(value)
	now := s.now().UTC()
	expiresAt := now.Add(s.sessionTTL)
	userAgent = truncate(strings.TrimSpace(userAgent), 512)
	var address any
	if parsed, err := netip.ParseAddr(strings.TrimSpace(remoteAddress)); err == nil {
		address = parsed.String()
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM user_sessions WHERE expires_at <= $1`, now); err != nil {
		return "", time.Time{}, fmt.Errorf("clean expired sessions: %w", err)
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO user_sessions(id,user_id,token_hash,expires_at,user_agent,ip_address)
		VALUES($1,$2,$3,$4,$5,$6)`,
		uuid.NewString(), userID, hash[:], expiresAt, userAgent, address); err != nil {
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
	err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE user_sessions s SET last_seen_at=$2
		FROM users u
		WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.id=s.user_id
		RETURNING u.id::text,u.email,u.display_name,COALESCE(u.avatar_url,'')`,
		hash[:], s.now().UTC()), &user)
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
	if _, err := s.pool.Exec(ctx, `DELETE FROM user_sessions WHERE token_hash=$1`, hash[:]); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

func SafeReturnPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") ||
		strings.ContainsAny(value, "\r\n") {
		return "/"
	}
	return value
}

type rowScanner interface {
	Scan(...any) error
}

func scanUser(row rowScanner, user *app.User) error {
	return row.Scan(&user.ID, &user.Email, &user.DisplayName, &user.AvatarURL)
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
