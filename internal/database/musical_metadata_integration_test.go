package database

import (
	"context"
	"errors"
	"os"
	"testing"
	"testing/fstest"
	"time"

	"github.com/bitofbytes-io/noted/migrations"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestIntegrationMusicalMetadataMigrationLockTimeoutRollsBack(t *testing.T) {
	dsn := os.Getenv("NOTED_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background()) //nolint:errcheck // Test connection cleanup.
	schema := "musical_migration_" + uuid.New().String()[:8]
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = conn.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := conn.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Error(err)
		}
	}()
	if _, err = conn.Exec(ctx, "SET search_path TO "+quoted+`; CREATE TABLE pieces (id text PRIMARY KEY,title text); INSERT INTO pieces VALUES('synthetic','Keep title'); CREATE TABLE schema_migrations (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	holder, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close(context.Background()) //nolint:errcheck // Test connection cleanup.
	lock, err := holder.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(context.Background()) //nolint:errcheck // Also safe after explicit rollback.
	if _, err = lock.Exec(ctx, "SELECT * FROM "+quoted+".pieces FOR UPDATE"); err != nil {
		t.Fatal(err)
	}
	body, err := migrations.FS.ReadFile("000014_musical_metadata.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{"000014_musical_metadata.up.sql": &fstest.MapFile{Data: body}}
	started := time.Now()
	err = Migrate(ctx, conn, files)
	var pgerr *pgconn.PgError
	if !errors.As(err, &pgerr) || pgerr.Code != "55P03" {
		t.Fatalf("expected lock timeout, got %v", err)
	}
	if elapsed := time.Since(started); elapsed < 4*time.Second || elapsed > 15*time.Second {
		t.Fatalf("lock timeout took %s", elapsed)
	}
	assertUnchanged := func() {
		t.Helper()
		var columns, versions int
		var title string
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='pieces' AND column_name IN ('opus','music_key')`, schema).Scan(&columns); err != nil {
			t.Fatal(err)
		}
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&versions); err != nil {
			t.Fatal(err)
		}
		if err := conn.QueryRow(ctx, `SELECT title FROM pieces WHERE id='synthetic'`).Scan(&title); err != nil {
			t.Fatal(err)
		}
		if columns != 0 || versions != 0 || title != "Keep title" {
			t.Fatalf("failed migration changed data: %d %d %q", columns, versions, title)
		}
	}
	assertUnchanged()
	if err = lock.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	// Inspect the actual migration's transaction-local limits, then roll it back.
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck // Also safe after explicit rollback.
	if _, err = tx.Exec(ctx, string(body)); err != nil {
		t.Fatal(err)
	}
	var lockTimeout, statementTimeout string
	if err = tx.QueryRow(ctx, `SELECT current_setting('lock_timeout'),current_setting('statement_timeout')`).Scan(&lockTimeout, &statementTimeout); err != nil {
		t.Fatal(err)
	}
	if lockTimeout != "5s" || statementTimeout != "1min" {
		t.Fatalf("wrong limits: %s %s", lockTimeout, statementTimeout)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	assertUnchanged()
	if err = Migrate(ctx, conn, files); err != nil {
		t.Fatal(err)
	}
	var opus, key string
	if err = conn.QueryRow(ctx, `SELECT opus,music_key FROM pieces WHERE id='synthetic'`).Scan(&opus, &key); err != nil || opus != "" || key != "" {
		t.Fatalf("retry defaults: %q %q %v", opus, key, err)
	}
	if err = conn.QueryRow(ctx, `SELECT current_setting('lock_timeout'),current_setting('statement_timeout')`).Scan(&lockTimeout, &statementTimeout); err != nil {
		t.Fatal(err)
	}
	if lockTimeout != "0" || statementTimeout != "0" {
		t.Fatalf("local limits leaked: %s %s", lockTimeout, statementTimeout)
	}
}
