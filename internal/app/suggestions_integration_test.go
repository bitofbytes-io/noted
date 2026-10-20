package app

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationSuggestions(t *testing.T) {
	dsn := os.Getenv("NOTED_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	owner, other := uuid.NewString(), uuid.NewString()
	for _, id := range []string{owner, other} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,display_name,auth_provider) VALUES($1,$2,'Suggestion tester','development')`, id, id+"@example.test"); err != nil {
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
	service.suggestions = newUserLimiter(1000, 1000, time.Minute, time.Now)
	create := func(user, title, composer, status string, favorite bool) Piece {
		t.Helper()
		p, err := service.CreatePiece(ctx, user, PieceInput{Title: title, Composer: composer, Status: &status, Favorite: favorite})
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	find := func(q string, options ...ListOptions) []PieceSummary {
		t.Helper()
		o := ListOptions{Query: q}
		if len(options) > 0 {
			o = options[0]
			o.Query = q
		}
		p, err := service.SuggestPieces(ctx, owner, o)
		if err != nil {
			t.Fatal(q, err)
		}
		return p
	}
	names := []string{"Rachmaninov", "Rachmaninoff", "Rachmaninow", "Tchaikovsky", "Tschaikowsky"}
	ids := map[string]string{}
	for _, name := range names {
		ids[name] = create(owner, "Prelude Op.28 No.4 C♯ minor", name, StatusShelved, true).ID
	}
	foreign := create(other, "Prelude Op.28 No.4 C♯ minor", "Rachmaninov", StatusLearning, true)
	for _, query := range names {
		for _, prefix := range []string{"", "Prelude op28 no4 C# minor "} {
			got := find(prefix + query)
			want := 2
			if strings.Contains(strings.ToLower(query), "chaik") {
				want = 1
			}
			if len(got) != want {
				t.Fatalf("%q: got %d want %d: %+v", prefix+query, len(got), want, got)
			}
			seen := map[string]bool{}
			for _, p := range got {
				if p.ID == ids[query] || p.ID == foreign.ID || seen[p.ID] {
					t.Fatal("exact/foreign/duplicate result", query, p)
				}
				seen[p.ID] = true
			}
		}
	}
	// Every token remains mandatory, with short/numeric/catalogue terms exact.
	for _, q := range []string{"", "%_", "123", "ra", "rachmaninov op29", "rachmaninov no5", "rachmaninov z", "tchaikovsky absentword"} {
		if got := find(q); len(got) != 0 {
			t.Fatal("unexpected result", q, got)
		}
	}
	if got := find("%_rachmaninov%_"); len(got) != 2 {
		t.Fatal("punctuation broadened or blocked query", got)
	}
	if got := find("Preludee Rachmaninov"); len(got) != 3 {
		t.Fatal("misspelled title and exact/fuzzy composer", got)
	}
	if got := find("prelude tschaikowsky tchaikovsky"); len(got) != 2 {
		t.Fatal("AND variant groups duplicated or lost rows", got)
	}
	f := false
	if got := find("rachmaninov", ListOptions{Favorite: &f}); len(got) != 0 {
		t.Fatal("favorite isolation", got)
	}
	if got := find("rachmaninov", ListOptions{Statuses: []string{StatusLearning}}); len(got) != 0 {
		t.Fatal("status isolation", got)
	}
	// Accent folding and title-only suggestions use the same existing search index.
	accent := create(owner, "Prélude", "Dvořák", StatusLearning, false)
	if got := find("Preludee dvorak"); len(got) != 1 || got[0].ID != accent.ID {
		t.Fatal("folded multi-term title suggestion", got)
	}
	create(owner, "Tschaikowsky study", "Other", StatusLearning, false)
	if got := find("tchaikovsky study"); len(got) != 1 {
		t.Fatal("title-only known variant", got)
	}
	// Explicitly verify the named-pair exception is not a threshold change.
	var raw float32
	if err := pool.QueryRow(ctx, `SELECT word_similarity('tchaikovsky','tschaikowsky')`).Scan(&raw); err != nil || raw >= 0.6 {
		t.Fatal("raw named-pair evidence", raw, err)
	}
	for _, pair := range [][2]string{{"abcdefghij", "abcdefgxxx"}, {"abcdefghij", "abcxefghij"}} {
		create(owner, "Threshold "+pair[1], "Unique", StatusLearning, false)
	}
	if got := find("abcdefghij"); len(got) != 1 || !strings.Contains(got[0].Title, "abcdefgxxx") {
		t.Fatal("0.6 threshold boundary", got)
	}
	// Exact rows exceed the limit but cannot crowd out additional matches.
	for range suggestionLimit + 3 {
		create(owner, "Exact", "rachmaninov", StatusLearning, false)
	}
	if got := find("rachmaninov"); len(got) != 2 {
		t.Fatal("exact exclusion happened after limit", got)
	}
	for i := 0; i < suggestionLimit+3; i++ {
		create(owner, "Tie", "Rachmaninoff", StatusLearning, false)
	}
	first, second := find("rachmaninov"), find("rachmaninov")
	if len(first) != suggestionLimit {
		t.Fatal("result bound", len(first))
	}
	for i := range first {
		if first[i].ID != second[i].ID {
			t.Fatal("unstable ranking")
		}
	}
	// Force one pooled connection to nondefault settings; request-local changes
	// must be restored after success, validation failure, cancellation and timeout.
	if _, err := pool.Exec(ctx, `SELECT set_config('pg_trgm.word_similarity_threshold','0.95',false),set_config('statement_timeout','5s',false)`); err != nil {
		t.Fatal(err)
	}
	if got := find("rachmaninov"); len(got) != suggestionLimit {
		t.Fatal("session threshold leaked into request", got)
	}
	assertSettings := func() {
		t.Helper()
		var threshold, timeout string
		if err := pool.QueryRow(ctx, `SELECT current_setting('pg_trgm.word_similarity_threshold'),current_setting('statement_timeout')`).Scan(&threshold, &timeout); err != nil || threshold != "0.95" || timeout != "5s" {
			t.Fatal("request setting leaked", threshold, timeout, err)
		}
	}
	assertSettings()
	if _, err := service.SuggestPieces(ctx, owner, ListOptions{Query: strings.Repeat("x", 201)}); err == nil {
		t.Fatal("oversized query accepted")
	}
	assertSettings()
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, err := service.SuggestPieces(canceled, owner, ListOptions{Query: "rachmaninov"}); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation ignored", err)
	}
	assertSettings()
	lockConn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer lockConn.Close(ctx) //nolint:errcheck // Test connection cleanup.
	lockTx, err := lockConn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lockTx.Rollback(ctx) //nolint:errcheck // Test lock cleanup, including committed transactions.
	if _, err := lockTx.Exec(ctx, `LOCK TABLE pieces IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := service.SuggestPieces(ctx, owner, ListOptions{Query: "rachmaninov"}); err == nil || time.Since(started) > 3*time.Second {
		t.Fatal("unbounded lock wait", err)
	}
	if err := lockTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	assertSettings()
	// A populated fixture plus EXPLAIN proves the indexed OR-variant path is
	// available. Disable sequential scans only in this test transaction.
	if _, err := pool.Exec(ctx, `INSERT INTO pieces(id,user_id,title,composer,search_text) SELECT md5($1::text||n::text)::uuid,$1::uuid,'Filler','Unrelated',md5(n::text)||' unrelated exercise' FROM generate_series(1,30000)n`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `VACUUM ANALYZE pieces`); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Read-only query plan test cleanup.
	if _, err := tx.Exec(ctx, `SET LOCAL enable_seqscan=off; SET LOCAL pg_trgm.word_similarity_threshold=0.6`); err != nil {
		t.Fatal(err)
	}
	query, args, err := suggestionQuery(owner, ListOptions{Query: "tchaikovsky"})
	if err != nil {
		t.Fatal(err)
	}
	var plan string
	if err := tx.QueryRow(ctx, "EXPLAIN (FORMAT JSON) "+query, args...).Scan(&plan); err != nil || !strings.Contains(plan, "pieces_search_trgm_idx") {
		t.Fatal("GIN variant path absent", plan, err)
	}
}
