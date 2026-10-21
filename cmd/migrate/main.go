package main

import (
	"context"
	"errors"
	"log"
	"os"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/bitofbytes-io/noted/internal/database"
	"github.com/bitofbytes-io/noted/migrations"
	"github.com/jackc/pgx/v5"
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
			log.Fatal("search repair failed; verify migration 14, compatible fold version and database availability; it is safe to retry")
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
