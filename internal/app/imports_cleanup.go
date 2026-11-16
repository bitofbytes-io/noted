package app

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

func queueKey(ctx context.Context, tx pgx.Tx, key string) error {
	_, err := tx.Exec(ctx, `INSERT INTO asset_deletion_queue(storage_key) SELECT $1 WHERE NOT EXISTS(SELECT 1 FROM piece_pdfs WHERE storage_key=$1) AND NOT EXISTS(SELECT 1 FROM import_assets WHERE storage_key=$1) ON CONFLICT DO NOTHING`, key)
	return err
}
func collectOrphans(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `WITH removed AS (DELETE FROM import_assets a WHERE NOT EXISTS(SELECT 1 FROM draft_sources WHERE asset_id=a.id) AND NOT EXISTS(SELECT 1 FROM piece_sources WHERE asset_id=a.id) RETURNING storage_key) INSERT INTO asset_deletion_queue(storage_key) SELECT storage_key FROM removed WHERE NOT EXISTS(SELECT 1 FROM piece_pdfs f WHERE f.storage_key=removed.storage_key) ON CONFLICT DO NOTHING`)
	return err
}
func (s *Service) queueObject(ctx context.Context, key string) {
	if _, err := s.pool.Exec(ctx, `INSERT INTO asset_deletion_queue(storage_key) VALUES($1) ON CONFLICT DO NOTHING`, key); err != nil {
		slog.Error("queueing unreferenced asset failed")
	}
}

// Durable retries: deleting files happens only after committed references disappear.
func (s *Service) CleanupImports(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
	if _, err = tx.Exec(ctx, `DELETE FROM import_drafts WHERE updated_at<now()-interval '7 days'`); err != nil {
		return err
	}
	if err = collectOrphans(ctx, tx); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	rows, err := s.pool.Query(ctx, `SELECT storage_key FROM asset_deletion_queue ORDER BY queued_at LIMIT 100`)
	if err != nil {
		return err
	}
	keys := []string{}
	for rows.Next() {
		var k string
		if err = rows.Scan(&k); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, k)
	}
	rows.Close()
	for _, k := range keys {
		var referenced bool
		if err = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM import_assets WHERE storage_key=$1) OR EXISTS(SELECT 1 FROM piece_pdfs WHERE storage_key=$1)`, k).Scan(&referenced); err != nil {
			return err
		}
		if referenced {
			continue
		}
		if err = s.store.Delete(ctx, k); err != nil {
			if _, retryErr := s.pool.Exec(ctx, `UPDATE asset_deletion_queue SET attempts=attempts+1 WHERE storage_key=$1`, k); retryErr != nil {
				slog.Warn("recording asset deletion retry failed")
			}
			continue
		}
		if _, err = s.pool.Exec(ctx, `DELETE FROM asset_deletion_queue WHERE storage_key=$1`, k); err != nil {
			return err
		}
	}
	return nil
}

// RunImportCleanup cleans up every minute until ctx ends. A non-nil observe
// receives each run's result, except runs cut short by shutdown.
func (s *Service) RunImportCleanup(ctx context.Context, observe func(error)) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		err := s.CleanupImports(ctx)
		if observe != nil && ctx.Err() == nil {
			observe(err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
