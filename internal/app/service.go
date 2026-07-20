package app

import (
	"context"
	"errors"
	"sync"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound               = errors.New("not found")
	ErrNotAuthorized          = errors.New("not authorized")
	ErrConflict               = errors.New("conflict")
	ErrAssetInUse             = errors.New("asset is referenced by practice history")
	ErrWorkInUse              = errors.New("work is referenced by practice history")
	ErrEditionInUse           = errors.New("edition contains an asset referenced by practice history")
	ErrRecognitionUnavailable = errors.New("score recognition is unavailable")
)

type Service struct {
	Pool                *pgxpool.Pool
	Store               assets.AssetStore
	Recognizer          Recognizer
	MeasureMapper       MeasureMapper
	recognitionWorkerID string
	recognitionSlots    chan struct{}
	recognitionWorker   sync.Once
	recognitionMu       sync.Mutex
	recognitionContext  context.Context
	recognitionCancels  map[string]context.CancelFunc
}

func NewService(pool *pgxpool.Pool, store assets.AssetStore) *Service {
	return &Service{
		Pool:                pool,
		Store:               store,
		recognitionWorkerID: uuid.NewString(),
		recognitionSlots:    make(chan struct{}, 1),
		recognitionCancels:  map[string]context.CancelFunc{},
	}
}

func (s *Service) WithRecognizer(recognizer Recognizer) *Service {
	s.Recognizer = recognizer
	if mapper, ok := recognizer.(MeasureMapper); ok {
		s.MeasureMapper = mapper
	}
	return s
}

func validateResourceID(value string) error {
	if err := uuid.Validate(value); err != nil {
		return ErrNotFound
	}
	return nil
}

func (s *Service) CurrentUser(ctx context.Context, email string) (User, error) {
	var user User
	err := s.Pool.QueryRow(ctx, `
		SELECT id::text, email, display_name, week_starts_on, metronome_bpm, metronome_accent
		FROM users WHERE email=$1`, email,
	).Scan(&user.ID, &user.Email, &user.DisplayName, &user.WeekStartsOn, &user.MetronomeBPM, &user.MetronomeAccent)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return user, err
}
