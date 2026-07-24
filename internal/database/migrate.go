package database

import (
	"context"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

func Migrate(ctx context.Context, conn *pgx.Conn, files fs.FS) error {
	if _, err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("create migration table: %w", err)
	}
	entries, err := fs.Glob(files, "*.up.sql")
	if err != nil {
		return err
	}
	sort.Strings(entries)
	for _, name := range entries {
		version := strings.TrimSuffix(name, ".up.sql")
		var applied bool
		if err := conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version=$1)`, version,
		).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		body, err := fs.ReadFile(files, name)
		if err != nil {
			return err
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, string(body)); err == nil {
			_, err = tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, version)
		}
		if err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

func Rollback(ctx context.Context, conn *pgx.Conn, files fs.FS) error {
	var version string
	err := conn.QueryRow(ctx,
		`SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
	).Scan(&version)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil
		}
		return err
	}
	name := version + ".down.sql"
	body, err := fs.ReadFile(files, name)
	if err != nil {
		return err
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, string(body)); err == nil {
		_, err = tx.Exec(ctx, `DELETE FROM schema_migrations WHERE version=$1`, version)
	}
	if err != nil {
		_ = tx.Rollback(ctx)
		return fmt.Errorf("rollback %s: %w", name, err)
	}
	return tx.Commit(ctx)
}
