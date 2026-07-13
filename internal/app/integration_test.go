package app

import (
	"context"
	"errors"
	"mime/multipart"
	"os"
	"path/filepath"
	"testing"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

func integrationService(t *testing.T) (*Service, User, string) {
	t.Helper()
	if os.Getenv("NOTED_INTEGRATION") != "1" {
		t.Skip("set NOTED_INTEGRATION=1 with local PostgreSQL running")
	}
	_ = godotenv.Load("../../.env")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	root := t.TempDir()
	store, err := assets.NewFilesystemStore(root)
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, store)
	user, err := service.CurrentUser(context.Background(), cfg.DevUserEmail)
	if err != nil {
		t.Fatalf("seed the development learner before integration tests: %v", err)
	}
	return service, user, root
}

func TestIntegrationOwnershipScoping(t *testing.T) {
	service, current, _ := integrationService(t)
	ctx := context.Background()
	otherUser := uuid.NewString()
	composer := uuid.NewString()
	work := uuid.NewString()
	edition := uuid.NewString()
	asset := uuid.NewString()
	key := "pdf/" + uuid.NewString()
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,display_name) VALUES($1,$2,'Other learner')`, []any{otherUser, otherUser + "@example.test"}},
		{`INSERT INTO composers(id,canonical_name,sort_name) VALUES($1,'Private Composer','Private Composer')`, []any{composer}},
		{`INSERT INTO works(id,composer_id,title,created_by_user_id) VALUES($1,$2,'Other learner work',$3)`, []any{work, composer, otherUser}},
		{`INSERT INTO learner_works(user_id,work_id) VALUES($1,$2)`, []any{otherUser, work}},
		{`INSERT INTO editions(id,work_id,name,created_by_user_id) VALUES($1,$2,'Private edition',$3)`, []any{edition, work, otherUser}},
		{`INSERT INTO score_assets(id,edition_id,asset_type,storage_key,original_filename,media_type,byte_size,sha256,rights_note,uploaded_by_user_id) VALUES($1,$2,'pdf',$3,'private.pdf','application/pdf',8,$4,'private',$5)`, []any{asset, edition, key, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", otherUser}},
	}
	for _, statement := range statements {
		if _, err := service.Pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = service.Pool.Exec(ctx, `DELETE FROM works WHERE id=$1`, work)
		_, _ = service.Pool.Exec(ctx, `DELETE FROM composers WHERE id=$1`, composer)
		_, _ = service.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, otherUser)
	})

	if _, err := service.GetWork(ctx, current.ID, work); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other learner's work must be hidden, got %v", err)
	}
	if _, err := service.GetAsset(ctx, current.ID, asset); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other learner's asset must be hidden, got %v", err)
	}
	if _, err := service.UpdateLearnerState(ctx, current.ID, work, LearnerStateInput{Status: "Learning"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other learner's state must not be mutable, got %v", err)
	}
	if _, err := service.CreateManualPractice(ctx, current.ID, PracticeInput{WorkID: work, DurationSeconds: 60}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other learner's work must not accept practice, got %v", err)
	}
}

func TestIntegrationUploadCleanupOnMetadataFailure(t *testing.T) {
	service, current, root := integrationService(t)
	path := filepath.Join(t.TempDir(), "exercise.pdf")
	if err := os.WriteFile(path, []byte("%PDF-1.4\nfixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	header := &multipart.FileHeader{Filename: "../../exercise.pdf", Size: 16}
	_, err = service.UploadAsset(context.Background(), current.ID, uuid.NewString(), header, file, UploadMetadata{RightsNote: "CC0"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected missing edition failure, got %v", err)
	}

	for _, kind := range []string{"pdf", "musicxml"} {
		entries, err := os.ReadDir(filepath.Join(root, "originals", kind))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("metadata failure left %d %s object(s)", len(entries), kind)
		}
	}
}
