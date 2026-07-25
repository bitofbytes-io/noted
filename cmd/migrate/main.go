package main

import (
	"context"
	"log"
	"os"

	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/bitofbytes-io/noted/internal/database"
	"github.com/bitofbytes-io/noted/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	databaseURL, err := config.LoadDatabaseURL()
	if err != nil {
		log.Fatal(err)
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close(ctx)
	if len(os.Args) == 2 && os.Args[1] == "down" {
		err = database.Rollback(ctx, conn, migrations.FS)
	} else if len(os.Args) == 1 {
		err = database.Migrate(ctx, conn, migrations.FS)
	} else {
		log.Fatal("usage: migrate [down]")
	}
	if err != nil {
		log.Fatal(err)
	}
}
