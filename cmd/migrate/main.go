package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"strings"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/bitofbytes-io/noted/internal/database"
	"github.com/bitofbytes-io/noted/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

func main() {
	if err := godotenv.Load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Print("optional .env file could not be loaded")
	}
	databaseURL, err := config.LoadDatabaseURL()
	if err != nil {
		log.Fatal(err)
	}
	ctx := context.Background()
	if len(os.Args) == 2 && os.Args[1] == "refold-search" {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		defer cancel()
		pool, err := pgxpool.New(ctx, databaseURL)
		if err != nil {
			log.Fatal("could not configure search repair database")
		}
		defer pool.Close()
		count, err := app.NewService(pool, nil).ForceRefoldSearchText(ctx)
		if err != nil {
			log.Fatal(searchRepairFailure(err))
		}
		log.Printf("refolded search text for %d pieces", count)
		return
	}
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer func() {
		if err := conn.Close(ctx); err != nil {
			log.Print("closing migration connection failed")
		}
	}()
	if len(os.Args) == 2 && os.Args[1] == "down" {
		err = database.Rollback(ctx, conn, migrations.FS)
	} else if len(os.Args) == 1 {
		err = database.Migrate(ctx, conn, migrations.FS)
	} else {
		log.Fatal("usage: migrate [down|refold-search]")
	}
	if err != nil {
		log.Fatal(err)
	}
}

// searchRepairFailure emits only bounded reason codes, never database error
// text, which can contain credentials, SQL, or private piece metadata.
func searchRepairFailure(err error) string {
	return fmt.Sprintf("search repair failed (reason=%s); verify migration 14, compatible fold version and database availability; it is safe to retry", searchRepairReason(err))
}

func searchRepairReason(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded), pgconn.Timeout(err):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, app.ErrSearchFoldVersionAhead):
		return "incompatible_fold_version"
	case errors.Is(err, pgx.ErrNoRows):
		return "missing_schema"
	}
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) {
		switch databaseError.Code {
		case "42P01", "42703", "3F000":
			return "missing_schema"
		case "57014":
			return "timeout"
		case "55P03":
			return "lock_timeout"
		case "57P01", "57P02", "57P03":
			return "database_unavailable"
		}
		if strings.HasPrefix(databaseError.Code, "08") {
			return "database_unavailable"
		}
	}
	var connectionError *pgconn.ConnectError
	var networkError *net.OpError
	if errors.As(err, &connectionError) || errors.As(err, &networkError) {
		return "database_unavailable"
	}
	return "unexpected_failure"
}
