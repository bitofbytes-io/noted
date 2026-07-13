package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/jackc/pgx/v5"
	"github.com/joho/godotenv"
)

const (
	userID     = "10000000-0000-4000-8000-000000000001"
	composerID = "10000000-0000-4000-8000-000000000002"
	workID     = "10000000-0000-4000-8000-000000000003"
	movementID = "10000000-0000-4000-8000-000000000004"
	editionID  = "10000000-0000-4000-8000-000000000005"
	learnerID  = "10000000-0000-4000-8000-000000000006"
	pdfAssetID = "10000000-0000-4000-8000-000000000007"
	xmlAssetID = "10000000-0000-4000-8000-000000000008"
	practiceID = "10000000-0000-4000-8000-000000000009"
	tagID      = "10000000-0000-4000-8000-000000000010"
)

func main() {
	_ = godotenv.Load()
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close(ctx)
	store, err := assets.NewFilesystemStore(cfg.AssetRoot)
	if err != nil {
		log.Fatal(err)
	}

	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,display_name,auth_provider) VALUES($1,$2,'Daniel — Development Learner','development') ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`, []any{userID, cfg.DevUserEmail}},
		{`INSERT INTO composers(id,canonical_name,sort_name) VALUES($1,'Noted Project','Noted Project') ON CONFLICT(id) DO NOTHING`, []any{composerID}},
		{`INSERT INTO works(id,composer_id,title,subtitle,catalog_number,key_signature,form,period,published_difficulty_label,notes,created_by_user_id) VALUES($1,$2,'Noted POC Exercise in C','Eight-measure hands-together study','NPE 1','C major','Exercise','Contemporary','Early intermediate','Original rights-safe demonstration work',$3) ON CONFLICT(id) DO NOTHING`, []any{workID, composerID, userID}},
		{`INSERT INTO movements(id,work_id,sequence_number,title,tempo_marking,measure_count) VALUES($1,$2,1,'Complete exercise','Moderato',8) ON CONFLICT(id) DO NOTHING`, []any{movementID, workID}},
		{`INSERT INTO editions(id,work_id,name,editor,publisher,source_url,rights_note,created_by_user_id) VALUES($1,$2,'Noted reference edition','Noted Project','Noted','https://github.com/bitofbytes-io/noted','Original fixture dedicated to the public domain under CC0-1.0',$3) ON CONFLICT(id) DO NOTHING`, []any{editionID, workID, userID}},
		{`INSERT INTO learner_works(id,user_id,work_id,status,is_favorite,last_bpm) VALUES($1,$2,$3,'Learning',true,96) ON CONFLICT(user_id,work_id) DO UPDATE SET status='Learning',is_favorite=true`, []any{learnerID, userID, workID}},
		{`INSERT INTO tags(id,user_id,name,normalized_name) VALUES($1,$2,'Warm-up','warm-up') ON CONFLICT(user_id,normalized_name) DO NOTHING`, []any{tagID, userID}},
		{`INSERT INTO learner_work_tags(learner_work_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, []any{learnerID, tagID}},
	}
	for _, statement := range statements {
		if _, err := conn.Exec(ctx, statement.sql, statement.args...); err != nil {
			log.Fatal(err)
		}
	}

	seedAsset(ctx, conn, store, pdfAssetID, editionID, userID, "pdf/20000000-0000-4000-8000-000000000001", "testdata/fixtures/noted-exercise.pdf", "application/pdf", "pdf", false)
	seedAsset(ctx, conn, store, xmlAssetID, editionID, userID, "musicxml/20000000-0000-4000-8000-000000000002", "testdata/fixtures/noted-exercise.musicxml", "application/vnd.recordare.musicxml+xml", "musicxml", true)

	now := time.Now().UTC()
	started := now.Add(-20 * time.Minute)
	if started.Before(app.MondayFor(now)) {
		started = now.Add(-5 * time.Minute)
	}
	_, err = conn.Exec(ctx, `INSERT INTO practice_sessions(id,user_id,work_id,movement_id,score_asset_id,started_at,ended_at,duration_seconds,entry_method,start_measure,end_measure,starting_bpm,ending_bpm,notes) VALUES($1,$2,$3,$4,$5,$6,$7,1200,'manual',1,8,88,96,'Seeded full-piece practice') ON CONFLICT(id) DO UPDATE SET started_at=EXCLUDED.started_at,ended_at=EXCLUDED.ended_at`, practiceID, userID, workID, movementID, xmlAssetID, started, started.Add(20*time.Minute))
	if err != nil {
		log.Fatal(err)
	}
	log.Print("development learner and CC0 score fixtures are seeded")
}

func seedAsset(ctx context.Context, conn *pgx.Conn, store assets.AssetStore, id, edition, user, key, path, mediaType, assetType string, playable bool) {
	data, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		log.Fatal(err)
	}
	if _, err := store.Put(ctx, key, bytes.NewReader(data)); err != nil {
		log.Fatal(err)
	}
	hash := sha256.Sum256(data)
	_, err = conn.Exec(ctx, `INSERT INTO score_assets(id,edition_id,asset_type,storage_key,original_filename,media_type,byte_size,sha256,source_url,rights_note,playback_capable,uploaded_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'https://github.com/bitofbytes-io/noted','Original fixture dedicated to the public domain under CC0-1.0',$9,$10) ON CONFLICT(id) DO UPDATE SET byte_size=EXCLUDED.byte_size,sha256=EXCLUDED.sha256`, id, edition, assetType, key, filepath.Base(path), mediaType, len(data), hex.EncodeToString(hash[:]), playable, user)
	if err != nil {
		log.Fatal(err)
	}
}
