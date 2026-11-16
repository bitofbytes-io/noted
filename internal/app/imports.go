package app

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

var ErrConflict = errors.New("draft changed; reload before saving")
var ErrPieceChanged = errors.New("saved piece changed; your draft is retained. Start a new preparation from the current piece before saving")
var ErrImportLimit = errors.New("import limit reached")

// ErrDraftLimit is the ErrImportLimit case of too many open drafts, which Send to
// Noted reports apart from file size.
var ErrDraftLimit = fmt.Errorf("%w: 20 open drafts", ErrImportLimit)

// ErrAssetStore wraps a failure to save an uploaded file in the asset store.
var ErrAssetStore = errors.New("score storage is unavailable")

const maxOpenDrafts = 20

// MaxPreparedPages caps the pages in one preparation draft. A saved score with
// more pages cannot be opened for preparation, so a draft never starts from a
// partial copy that would replace the full PDF on an unchanged save.
const MaxPreparedPages = 10

var ErrTooManyPages = invalid("page editing supports scores of up to %d pages, so a longer score's PDF cannot be changed in Noted", MaxPreparedPages)

// The import code is split by concern: imports_drafts.go (draft CRUD),
// imports_sources.go (source upload and download), imports_finalize.go (saving
// a draft as a piece) and imports_cleanup.go (orphan and expiry cleanup). This
// file holds what they share.

func (s *Service) importLimit() int64 {
	if s.maxUploadBytes > 0 {
		return s.maxUploadBytes
	}
	return 50 << 20
}
func lockOwner(ctx context.Context, tx pgx.Tx, owner string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, owner)
	return err
}
func (s *Service) importTx(ctx context.Context, owner string) (pgx.Tx, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if err = lockOwner(ctx, tx, owner); err != nil {
		_ = tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
		return nil, err
	}
	return tx, nil
}
