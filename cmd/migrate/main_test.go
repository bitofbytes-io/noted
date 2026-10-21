package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestSearchRepairFailureReasonsNeverExposeErrorDetails(t *testing.T) {
	const private = "postgres://private-user:private-password@private-host/private-db private-piece-title" // #nosec G101 -- Synthetic secret marker to prove error redaction.
	tests := []struct {
		name   string
		err    error
		reason string
	}{
		{"deadline", context.DeadlineExceeded, "timeout"},
		{"cancel", context.Canceled, "canceled"},
		{"fold", app.ErrSearchFoldVersionAhead, "incompatible_fold_version"},
		{"missing state", pgx.ErrNoRows, "missing_schema"},
		{"missing table", &pgconn.PgError{Code: "42P01", Message: private}, "missing_schema"},
		{"missing column", &pgconn.PgError{Code: "42703", Message: private}, "missing_schema"},
		{"statement timeout", &pgconn.PgError{Code: "57014", Message: private}, "timeout"},
		{"lock timeout", &pgconn.PgError{Code: "55P03", Message: private}, "lock_timeout"},
		{"shutdown", &pgconn.PgError{Code: "57P01", Message: private}, "database_unavailable"},
		{"connection state", &pgconn.PgError{Code: "08006", Message: private}, "database_unavailable"},
		{"network", &net.OpError{Op: "dial", Net: "tcp", Err: errors.New(private)}, "database_unavailable"},
		{"unknown", errors.New(private), "unexpected_failure"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := fmt.Errorf("%s: %w", private, test.err)
			want := "search repair failed (reason=" + test.reason + "); verify migration 14, compatible fold version and database availability; it is safe to retry"
			got := searchRepairFailure(err)
			if got != want || strings.Contains(got, "private") {
				t.Fatalf("unsafe or incorrect failure message: %q", got)
			}
		})
	}
	// Exercise the driver's connection wrapper with a stub dialer, without DNS
	// resolution or a real socket, so private connection settings never escape.
	cfg, err := pgconn.ParseConfig("postgres://private-user:private-password@127.0.0.1/private-db?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	cfg.DialFunc = func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New(private)
	}
	_, err = pgconn.ConnectConfig(context.Background(), cfg)
	if err == nil || searchRepairReason(err) != "database_unavailable" || strings.Contains(searchRepairFailure(err), "private") {
		t.Fatal("connection failure was not safely classified")
	}
}
