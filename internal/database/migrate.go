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
	reset, err := resetLegacySchema(ctx, conn, files)
	if err != nil {
		return err
	}
	if reset {
		return nil
	}
	if _, err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("create migration table: %w", err)
	}
	entries, err := migrationEntries(files)
	if err != nil {
		return err
	}
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

func resetLegacySchema(ctx context.Context, conn *pgx.Conn, files fs.FS) (bool, error) {
	var legacy, binder bool
	if err := conn.QueryRow(ctx, `
		SELECT
			to_regclass('public.works') IS NOT NULL,
			to_regclass('public.pieces') IS NOT NULL
	`).Scan(&legacy, &binder); err != nil {
		return false, fmt.Errorf("inspect schema generation: %w", err)
	}
	if !legacy {
		return false, nil
	}
	if binder {
		return false, fmt.Errorf("legacy and binder schemas both exist; refusing automatic reset")
	}

	entries, err := migrationEntries(files)
	if err != nil {
		return false, err
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
		SELECT tablename
		FROM pg_catalog.pg_tables
		WHERE schemaname = 'public'
		ORDER BY tablename
	`)
	if err != nil {
		return false, fmt.Errorf("list legacy tables: %w", err)
	}
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			rows.Close()
			return false, fmt.Errorf("scan legacy table: %w", err)
		}
		tables = append(tables, table)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return false, fmt.Errorf("list legacy tables: %w", err)
	}
	rows.Close()

	for _, table := range tables {
		identifier := pgx.Identifier{"public", table}.Sanitize()
		if _, err := tx.Exec(ctx, "DROP TABLE "+identifier+" CASCADE"); err != nil {
			return false, fmt.Errorf("drop legacy table %s: %w", identifier, err)
		}
	}
	if _, err := tx.Exec(ctx, `
		CREATE TABLE schema_migrations (
			version TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return false, fmt.Errorf("recreate migration table: %w", err)
	}
	for _, name := range entries {
		body, err := fs.ReadFile(files, name)
		if err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			return false, fmt.Errorf("apply %s after legacy reset: %w", name, err)
		}
		version := strings.TrimSuffix(name, ".up.sql")
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (version) VALUES ($1)`, version,
		); err != nil {
			return false, fmt.Errorf("record %s after legacy reset: %w", name, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit legacy schema reset: %w", err)
	}
	return true, nil
}

func migrationEntries(files fs.FS) ([]string, error) {
	entries, err := fs.Glob(files, "*.up.sql")
	if err != nil {
		return nil, err
	}
	sort.Strings(entries)
	return entries, nil
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
