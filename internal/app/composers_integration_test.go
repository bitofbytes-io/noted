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
	"github.com/jackc/pgx/v5"
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
	// Legacy spellings must remain selectable exactly, without silently selecting
	// a different, trimmed identity or preventing cleanup of the legacy name.
	plain := create(owner, "Mozart")
	legacy := create(owner, "Legacy placeholder")
	if _, err := pool.Exec(ctx, `UPDATE pieces SET composer=$2 WHERE id=$1`, legacy.ID, " Mozart "); err != nil {
		t.Fatal(err)
	}
	legacyInput := ComposerMerge{Spellings: []string{" Mozart "}, Target: "Wolfgang Mozart"}
	legacyPreview, err := service.PreviewComposerMerge(ctx, owner, legacyInput)
	if err != nil || legacyPreview.Count != 1 || legacyPreview.Pieces[0].ID != legacy.ID {
		t.Fatal("legacy exact spelling was not selected", legacyPreview, err)
	}
	legacyInput.Fingerprint = legacyPreview.Fingerprint
	if _, err := service.MergeComposers(ctx, owner, legacyInput); err != nil {
		t.Fatal("legacy spelling merge failed", err)
	}
	for id, want := range map[string]string{plain.ID: "Mozart", legacy.ID: "Wolfgang Mozart"} {
		piece, err := service.GetPiece(ctx, owner, id)
		if err != nil || piece.Composer != want {
			t.Fatal("legacy merge changed wrong identity", piece.Composer, want, err)
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
	other := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,display_name,auth_provider) VALUES($1,$2,'Repair tester','development')`, owner, owner+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,display_name,auth_provider) VALUES($1,$2,'Other repair tester','development')`, other, other+"@example.test"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM pieces WHERE user_id=ANY($1::uuid[])`, []string{owner, other}); err != nil {
			t.Error(err)
		}
		if _, err := pool.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1::uuid[])`, []string{owner, other}); err != nil {
			t.Error(err)
		}
	}()
	// Include another owner's stale rows: repair is global and needs more than two batches.
	for _, user := range []string{owner, other} {
		for range composerRepairBatch + 1 {
			if _, err := pool.Exec(ctx, `INSERT INTO pieces(id,user_id,title,composer) VALUES($1,$2,'Old writer','Chopin, Frédéric')`, uuid.NewString(), user); err != nil {
				t.Fatal(err)
			}
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
	// A new instance resumes until the global backlog drains, bounded by ctx.
	resumed := NewService(pool, nil)
	total := 0
	for {
		count, err = resumed.RepairComposerKeys(ctx)
		if err != nil || count < 0 || count > composerRepairBatch {
			t.Fatal("repair did not resume within the batch bound", count, err)
		}
		if count == 0 {
			break
		}
		total += count
	}
	if total < composerRepairBatch+2 {
		t.Fatal("remaining owner and unrelated rows were not repaired", total)
	}
	var bad int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pieces WHERE user_id=$1 AND (composer_sort<>'chopin frederic' OR composer_sort_source<>composer OR composer_sort_version<>1)`, owner).Scan(&bad); err != nil || bad != 0 {
		t.Fatal("incorrect repaired keys", bad, err)
	}
}

// Pause after rows have been consumed and the merge set has been selected, while
// its transaction still holds locks. This is test instrumentation, not a DB trigger.
type composerSelectionTraceKey struct{}
type composerSelectionPause struct {
	selected chan uint32
	release  chan struct{}
}

func (p *composerSelectionPause) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, composerSelectionTraceKey{}, strings.Contains(data.SQL, "FOR UPDATE OF p"))
}
func (p *composerSelectionPause) TraceQueryEnd(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryEndData) {
	if selected, _ := ctx.Value(composerSelectionTraceKey{}).(bool); !selected || data.Err != nil {
		return
	}
	select {
	case p.selected <- conn.PgConn().PID():
	case <-ctx.Done():
		return
	}
	select {
	case <-p.release:
	case <-ctx.Done():
	}
}

func TestIntegrationComposerMergeOldWriter(t *testing.T) {
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
	owner, other := uuid.NewString(), uuid.NewString()
	for _, id := range []string{owner, other} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,display_name,auth_provider) VALUES($1,$2,'Mixed writer tester','development')`, id, id+"@example.test"); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for _, q := range []string{`DELETE FROM pieces WHERE user_id=ANY($1::uuid[])`, `DELETE FROM users WHERE id=ANY($1::uuid[])`} {
			if _, err := pool.Exec(context.Background(), q, []string{owner, other}); err != nil {
				t.Error(err)
			}
		}
	}()
	service := NewService(pool, nil)
	first, err := service.CreatePiece(ctx, owner, PieceInput{Title: "Initial", Composer: "Chopin"})
	if err != nil {
		t.Fatal(err)
	}
	input := ComposerMerge{Spellings: []string{"Chopin"}, Target: "Frédéric Chopin"}
	preview, err := service.PreviewComposerMerge(ctx, owner, input)
	if err != nil {
		t.Fatal(err)
	}
	input.Fingerprint = preview.Fingerprint
	// Emulate the old direct INSERT, deliberately taking no advisory lock.
	const oldInsert = `INSERT INTO pieces(id,user_id,title,composer) VALUES($1,$2,'Old replica','Chopin')`
	beforeID := uuid.NewString()
	oldTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer oldTx.Rollback(ctx) //nolint:errcheck // Best-effort cleanup, including committed transactions.
	if _, err := oldTx.Exec(ctx, oldInsert, beforeID, owner); err != nil {
		t.Fatal(err)
	}
	// An uncommitted old insert holds FK KEY SHARE. A waiting merge respects
	// cancellation and leaves no writes or advisory lock behind.
	waiting, stop := context.WithTimeout(ctx, 50*time.Millisecond)
	_, waitErr := service.MergeComposers(waiting, owner, input)
	stop()
	if !errors.Is(waitErr, context.DeadlineExceeded) {
		t.Fatal("merge did not respect cancellation while waiting for old writer", waitErr)
	}
	if err := oldTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := service.MergeComposers(ctx, owner, input); !errors.Is(err, ErrComposerChanged) {
		t.Fatal("old insert before merge accepted a stale fingerprint", err)
	}
	preview, err = service.PreviewComposerMerge(ctx, owner, input)
	if err != nil {
		t.Fatal(err)
	}
	input.Fingerprint = preview.Fingerprint
	pause := &composerSelectionPause{selected: make(chan uint32, 1), release: make(chan struct{})}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = pause
	mergePool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer mergePool.Close()
	release := sync.OnceFunc(func() { close(pause.release) })
	defer release()
	merged := make(chan error, 1)
	go func() {
		result, err := NewService(mergePool, nil).MergeComposers(ctx, owner, input)
		if err == nil && result.Count != 2 {
			err = errors.New("merge changed the confirmed count")
		}
		merged <- err
	}()
	var mergePID uint32
	select {
	case mergePID = <-pause.selected:
	case err := <-merged:
		t.Fatal("merge ended before selection pause", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	writer, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Release()
	writerPID := writer.Conn().PgConn().PID()
	inserted := make(chan error, 1)
	afterID := uuid.NewString()
	go func() {
		_, err := writer.Exec(ctx, oldInsert, afterID, owner)
		inserted <- err
	}()
	// Observe the actual FK lock wait, rather than infer blocking from a sleep.
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2::integer))`, mergePID, writerPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case err := <-inserted:
			t.Fatal("old insert bypassed the selected merge set", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	// The lock is per owner; an unrelated old replica insert still succeeds.
	if _, err := pool.Exec(ctx, oldInsert, uuid.NewString(), other); err != nil {
		t.Fatal("foreign owner insert was blocked", err)
	}
	release()
	for _, done := range []<-chan error{merged, inserted} {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	for id, want := range map[string]string{first.ID: input.Target, beforeID: input.Target, afterID: "Chopin"} {
		piece, err := service.GetPiece(ctx, owner, id)
		if err != nil || piece.Composer != want {
			t.Fatal("old insert did not serialize after the merge", id, piece.Composer, want, err)
		}
	}
}
