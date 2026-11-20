package app

import (
	"context"
	"errors"
	"time"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("not found")

type Service struct {
	pool           *pgxpool.Pool
	store          assets.Store
	maxUploadBytes int64
	imslp          *imslpSearcher
	shortcuts      *userLimiter
	exports        *exportLimiter
	suggestions    *userLimiter
}

func NewService(pool *pgxpool.Pool, store assets.Store, limits ...int64) *Service {
	s := &Service{
		pool: pool, store: store, imslp: newIMSLPSearcher(IMSLPSearchConfig{}),
		shortcuts:   newUserLimiter(10.0/60, 10, 10*time.Minute, time.Now),
		exports:     newExportLimiter(time.Now),
		suggestions: newUserLimiter(4, 8, 10*time.Minute, time.Now),
	}
	if len(limits) > 0 {
		s.maxUploadBytes = limits[0]
	}
	return s
}

// PingDatabase and CheckAssetStore back the API's readiness probe.
func (s *Service) PingDatabase(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

func (s *Service) CheckAssetStore(ctx context.Context) error {
	return s.store.Check(ctx)
}
