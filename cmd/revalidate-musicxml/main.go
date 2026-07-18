package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	store, err := assets.NewFilesystemStore(cfg.AssetRoot)
	if err != nil {
		log.Fatal(err)
	}
	summary, err := app.NewService(pool, store).RevalidateMusicXMLAssets(ctx)
	if encodeErr := json.NewEncoder(log.Writer()).Encode(summary); encodeErr != nil {
		log.Fatal(encodeErr)
	}
	if err != nil {
		log.Fatal(err)
	}
}
