package app

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationComposers(t *testing.T) {
	dsn := os.Getenv("NOTED_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store, err := assets.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, store)
	owner, other := uuid.NewString(), uuid.NewString()
	for _, id := range []string{owner, other} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,display_name,auth_provider) VALUES($1,$2,'Composer tester','development')`, id, id+"@example.test"); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for _, q := range []string{`DELETE FROM import_drafts WHERE user_id=ANY($1::uuid[])`, `DELETE FROM pieces WHERE user_id=ANY($1::uuid[])`, `DELETE FROM users WHERE id=ANY($1::uuid[])`} {
			if _, err := pool.Exec(context.Background(), q, []string{owner, other}); err != nil {
				t.Error(err)
			}
		}
	}()
	create := func(user, name string) Piece {
		t.Helper()
		p, err := service.CreatePiece(ctx, user, PieceInput{Title: "Exercise " + name, Composer: name, Aliases: "Nickname", Notes: "Keep notes"})
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	first := create(owner, "Chopin")
	second := create(owner, "Chopin, Frédéric")
	foreign := create(other, "Chopin")
	create(owner, "C. P. E. Bach")
	create(owner, "J. S. Bach")
	create(owner, "")
	assertKey := func(id, name string) {
		t.Helper()
		var key, source string
		var version int
		if err := pool.QueryRow(ctx, `SELECT composer_sort,composer_sort_source,composer_sort_version FROM pieces WHERE id=$1`, id).Scan(&key, &source, &version); err != nil {
			t.Fatal(err)
		}
		if key != composerSortKey(name) || source != name || version != 1 {
			t.Fatalf("key for %q: %q %q %d", name, key, source, version)
		}
	}
	assertKey(first.ID, "Chopin")
	assertKey(second.ID, "Chopin, Frédéric")
	// Simulate both pre-migration rows and an old replica writing after repair.
	if _, err := pool.Exec(ctx, `UPDATE pieces SET composer_sort='',composer_sort_source='',composer_sort_version=0 WHERE user_id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	var before time.Time
	if err := pool.QueryRow(ctx, `SELECT updated_at FROM pieces WHERE id=$1`, first.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	entries, err := service.ListComposers(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	bach := 0
	for _, e := range entries {
		if e.Name == "Chopin" && (e.Count != 1 || e.Key != "chopin") {
			t.Fatal("foreign count or stale key", e)
		}
		if e.Group == "bach" {
			bach++
		}
	}
	if len(entries) != 5 || bach != 2 {
		t.Fatal("distinct spellings/grouping", entries)
	}
	// Concurrent repairers may divide the batch; neither may corrupt a key.
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			if _, err := service.RepairComposerKeys(ctx); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	assertKey(first.ID, "Chopin")
	if _, err := service.RepairComposerKeys(ctx); err != nil {
		t.Fatal("repeat repair failed", err)
	}
	var after time.Time
	if err := pool.QueryRow(ctx, `SELECT updated_at FROM pieces WHERE id=$1`, first.ID).Scan(&after); err != nil || !before.Equal(after) {
		t.Fatal("derived repair changed modified time", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE pieces SET composer='Frédéric Chopin' WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	entries, err = service.ListComposers(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range entries {
		if e.Name == "Frédéric Chopin" {
			found = e.Key == "chopin frederic" && e.Group == "chopin"
		}
	}
	if !found {
		t.Fatal("old-writer stale key not repaired on read")
	}
	if _, err := service.RepairComposerKeys(ctx); err != nil {
		t.Fatal(err)
	}
	assertKey(first.ID, "Frédéric Chopin")
	name := "Chopin"
	if _, err := service.UpdatePiece(ctx, owner, first.ID, PiecePatch{Composer: &name}); err != nil {
		t.Fatal(err)
	}
	assertKey(first.ID, name)

	input := ComposerMerge{Spellings: []string{"Chopin", "Chopin, Frédéric"}, Target: "Frédéric Chopin"}
	preview, err := service.PreviewComposerMerge(ctx, owner, input)
	if err != nil || preview.Count != 2 {
		t.Fatal("preview", preview, err)
	}
	input.Fingerprint = preview.Fingerprint
	if _, err := service.MergeComposers(ctx, other, input); err == nil {
		t.Fatal("foreign preview authorized merge")
	}
	// Add, rename and delete between preview and confirmation must all conflict.
	extra := create(owner, "Chopin")
	if _, err := service.MergeComposers(ctx, owner, input); !errors.Is(err, ErrComposerChanged) {
		t.Fatal("added match accepted stale preview", err)
	}
	preview, err = service.PreviewComposerMerge(ctx, owner, input)
	if err != nil {
		t.Fatal(err)
	}
	input.Fingerprint = preview.Fingerprint
	renamed := "Different"
	if _, err := service.UpdatePiece(ctx, owner, extra.ID, PiecePatch{Composer: &renamed}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.MergeComposers(ctx, owner, input); !errors.Is(err, ErrComposerChanged) {
		t.Fatal("renamed match accepted stale preview", err)
	}
	extra = create(owner, "Chopin")
	preview, err = service.PreviewComposerMerge(ctx, owner, input)
	if err != nil {
		t.Fatal(err)
	}
	input.Fingerprint = preview.Fingerprint
	if err := service.DeletePiece(ctx, owner, extra.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.MergeComposers(ctx, owner, input); !errors.Is(err, ErrComposerChanged) {
		t.Fatal("deleted match accepted stale preview", err)
	}
	preview, err = service.PreviewComposerMerge(ctx, owner, input)
	if err != nil {
		t.Fatal(err)
	}
	input.Fingerprint = preview.Fingerprint
	// Real PDF and reader state survive the bulk metadata update.
	pdf, err := os.ReadFile("../../testdata/fixtures/noted-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}
	saved, err := preparePDF(ctx, service, owner, first.ID, "score.pdf", pdf)
	if err != nil {
		t.Fatal(err)
	}
	assertKey(first.ID, "Chopin")
	state, err := service.GetReaderState(ctx, owner, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Force a later row's update to fail and prove the earlier write rolls back.
	lastID := first.ID
	if second.ID > lastID {
		lastID = second.ID
	}
	if _, err := pool.Exec(ctx, `UPDATE pieces SET title='BOB44 rollback sentinel' WHERE id=$1`, lastID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE FUNCTION bob44_reject_merge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title='BOB44 rollback sentinel' AND NEW.composer='Frédéric Chopin' THEN RAISE EXCEPTION 'synthetic merge failure'; END IF; RETURN NEW; END $$;
	 CREATE TRIGGER bob44_reject_merge BEFORE UPDATE ON pieces FOR EACH ROW EXECUTE FUNCTION bob44_reject_merge()`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS bob44_reject_merge ON pieces; DROP FUNCTION IF EXISTS bob44_reject_merge()`); err != nil {
			t.Error(err)
		}
	}()
	if _, err := service.MergeComposers(ctx, owner, input); err == nil {
		t.Fatal("synthetic partial merge succeeded")
	}
	for _, id := range []string{first.ID, second.ID} {
		p, err := service.GetPiece(ctx, owner, id)
		if err != nil || p.Composer == input.Target {
			t.Fatal("failed merge partially changed composer", err)
		}
	}
	if _, err := pool.Exec(ctx, `DROP TRIGGER bob44_reject_merge ON pieces; DROP FUNCTION bob44_reject_merge()`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.MergeComposers(ctx, owner, input); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{first.ID, second.ID} {
		p, err := service.GetPiece(ctx, owner, id)
		if err != nil || p.Composer != input.Target || p.Aliases != "Nickname" || p.Notes != "Keep notes" {
			t.Fatal("merge changed unrelated metadata", p, err)
		}
		assertKey(id, input.Target)
	}
	p, err := service.GetPiece(ctx, owner, first.ID)
	if err != nil || p.PDF.ChecksumSHA256 != saved.PDF.ChecksumSHA256 {
		t.Fatal("merge changed PDF", err)
	}
	nowState, err := service.GetReaderState(ctx, owner, first.ID)
	if err != nil || nowState != state {
		t.Fatal("merge changed reader state", err)
	}
	foreignAfter, err := service.GetPiece(ctx, other, foreign.ID)
	if err != nil || foreignAfter.Composer != "Chopin" {
		t.Fatal("merge touched foreign piece", err)
	}
	summaries, err := service.ListPieceSummaries(ctx, owner, ListOptions{Sort: SortTitle})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range summaries {
		if p.ID == first.ID && !strings.Contains(p.SearchText, "frederic chopin") {
			t.Fatal("merge search text stale")
		}
	}
	if _, err := service.MergeComposers(ctx, owner, input); !errors.Is(err, ErrComposerChanged) {
		t.Fatal("replayed stale merge accepted", err)
	}
	for _, bad := range []ComposerMerge{{}, {Spellings: []string{"Chopin"}, Target: " "}, {Spellings: []string{"Chopin"}, Target: strings.Repeat("x", 301)}, {Spellings: []string{"forged"}, Target: "Chopin"}} {
		if _, err := service.PreviewComposerMerge(ctx, owner, bad); err == nil {
			t.Fatal("invalid/foreign spelling accepted", bad)
		}
	}
}

func TestIntegrationComposerRepairBatches(t *testing.T) {
	dsn := os.Getenv("NOTED_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	owner := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,display_name,auth_provider) VALUES($1,$2,'Repair tester','development')`, owner, owner+"@example.test"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM pieces WHERE user_id=$1`, owner); err != nil {
			t.Error(err)
		}
		if _, err := pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, owner); err != nil {
			t.Error(err)
		}
	}()
	for range composerRepairBatch + 1 {
		if _, err := pool.Exec(ctx, `INSERT INTO pieces(id,user_id,title,composer) VALUES($1,$2,'Old writer','Chopin, Frédéric')`, uuid.NewString(), owner); err != nil {
			t.Fatal(err)
		}
	}
	service := NewService(pool, nil)
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, err := service.RepairComposerKeys(canceled); err == nil {
		t.Fatal("canceled repair succeeded")
	}
	count, err := service.RepairComposerKeys(ctx)
	if err != nil || count != composerRepairBatch {
		t.Fatal("repair was not bounded", count, err)
	}
	// A new instance resumes the remaining stale row, including startup races.
	count, err = NewService(pool, nil).RepairComposerKeys(ctx)
	if err != nil || count < 1 || count > composerRepairBatch {
		t.Fatal("repair did not resume", count, err)
	}
	var bad int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pieces WHERE user_id=$1 AND (composer_sort<>'chopin frederic' OR composer_sort_source<>composer OR composer_sort_version<>1)`, owner).Scan(&bad); err != nil || bad != 0 {
		t.Fatal("incorrect repaired keys", bad, err)
	}
}
