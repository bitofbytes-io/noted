package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestFetchIMSLPPage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("start") != "0" {
			t.Errorf("unexpected start: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"0":{"id":"Prelude (Example, Ada)","type":"2","intvals":{"worktitle":"Prelude","composer":"Example, Ada"},"permlink":"https://imslp.org/wiki/Prelude_(Example,_Ada)"},"metadata":{"start":0,"limit":1000,"moreresultsavailable":false}}`)
	}))
	defer server.Close()
	works, more, err := fetchIMSLPPage(context.Background(), server.Client(), server.URL+"?start=%d", 0)
	if err != nil || more || len(works) != 1 || works[0].Intvals.Title != "Prelude" {
		t.Fatalf("worklist parse: %+v, more=%v, err=%v", works, more, err)
	}
}

func TestCanonicalIMSLPWorkURLPreservesQuestionMarkInTitle(t *testing.T) {
	url, ok := canonicalIMSLPWorkURL("https://imslp.org/wiki/'Who_are_We?'_from_Psalm_8_(Ludtke,_William_G.)")
	if !ok || !strings.Contains(url, "We%3F'") || !validIMSLPWorkURL(url) {
		t.Fatalf("wiki title was not preserved: %q, valid=%v", url, ok)
	}
}

func TestFetchIMSLPPageRejectsPartialOrUntrustedData(t *testing.T) {
	for _, payload := range []string{
		`{"0":{"id":"x","type":"2","intvals":{"worktitle":"x"},"permlink":"https://imslp.org/wiki/x"},"metadata":{"start":0,"limit":1000}}`,
		`{"0":{"id":"x","type":"2","intvals":{"worktitle":"x"},"permlink":"https://evil.example/wiki/x"},"metadata":{"start":0,"limit":1000,"moreresultsavailable":false}}`,
		`{"metadata":{"start":0,"limit":1000,"moreresultsavailable":true}}`,
		`{"0":{"id":"x","type":"2","intvals":{"worktitle":"x"},"permlink":"https://imslp.org/wiki/x"},"metadata":{"start":1,"limit":1000,"moreresultsavailable":false}}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprint(w, payload)
		}))
		_, _, err := fetchIMSLPPage(context.Background(), server.Client(), server.URL+"?start=%d", 0)
		server.Close()
		if err == nil {
			t.Fatalf("accepted invalid page: %s", payload)
		}
	}
}

func TestFetchIMSLPPageNeverFollowsRedirect(t *testing.T) {
	targetHits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetHits++
		fmt.Fprint(w, `{"metadata":{"start":0,"limit":1000,"moreresultsavailable":false}}`)
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer server.Close()
	_, _, err := fetchIMSLPPage(context.Background(), server.Client(), server.URL+"?start=%d", 0)
	if !errors.Is(err, errIMSLPCatalogData) || targetHits != 0 {
		t.Fatalf("redirect was followed or accepted: hits=%d err=%v", targetHits, err)
	}
}

func TestIMSLPCatalogRetriesInitialFailureAndLockContention(t *testing.T) {
	for _, test := range []struct {
		name  string
		first error
		want  time.Duration
	}{
		{name: "network failure", first: errors.New("temporary timeout"), want: 5 * time.Minute},
		{name: "another instance is refreshing", first: errIMSLPCatalogBusy, want: 2 * time.Minute},
		{name: "bad worklist data", first: errIMSLPCatalogData, want: 6 * time.Hour},
	} {
		t.Run(test.name, func(t *testing.T) {
			attempts := 0
			var delays []time.Duration
			runIMSLPCatalog(context.Background(), func(context.Context) error {
				attempts++
				if attempts == 1 {
					return test.first
				}
				return nil
			}, func(_ context.Context, delay time.Duration) bool {
				delays = append(delays, delay)
				return len(delays) < 2
			})
			if attempts != 2 || len(delays) != 2 || delays[0] != test.want || delays[1] != 24*time.Hour {
				t.Fatalf("retry sequence attempts=%d delays=%v", attempts, delays)
			}
		})
	}
	if got := imslpRetryDelay(errors.New("temporary timeout"), 4); got != time.Hour {
		t.Fatalf("backoff cap = %v", got)
	}
}

func TestIntegrationIMSLPCatalogKeepsLastCompleteSnapshot(t *testing.T) {
	databaseURL := os.Getenv("NOTED_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `UPDATE imslp_catalog_state SET active_generation=NULL, refreshed_at=NULL, last_error=NULL WHERE id=TRUE`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `DELETE FROM imslp_catalog_works`)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM imslp_catalog_works`)
		_, _ = pool.Exec(cleanupCtx, `UPDATE imslp_catalog_state SET active_generation=NULL, refreshed_at=NULL, last_error=NULL WHERE id=TRUE`)
		pool.Close()
	})
	s := NewService(pool, nil)
	other, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var locked bool
	if err := other.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, imslpCatalogLock).Scan(&locked); err != nil || !locked {
		t.Fatalf("could not acquire competing lock: %v", err)
	}
	lockResult := s.refreshIMSLPCatalog(ctx, http.DefaultClient, "http://unused.invalid/?start=%d", 0, 1)
	if !errors.Is(lockResult, errIMSLPCatalogBusy) {
		t.Fatalf("lock contention did not trigger retry: %v", lockResult)
	}
	if _, err := other.Exec(ctx, `SELECT pg_advisory_unlock($1)`, imslpCatalogLock); err != nil {
		t.Fatal(err)
	}
	other.Release()
	before, err := s.SearchIMSLP(ctx, "Prelude")
	if err != nil || before.Status != "loading" || len(before.Results) != 0 {
		t.Fatalf("initial state: %+v, %v", before, err)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"metadata":{"start":0,"limit":1000,"moreresultsavailable":true}}`)
	}))
	defer bad.Close()
	if err := s.refreshIMSLPCatalog(ctx, bad.Client(), bad.URL+"?start=%d", 0, 1); err == nil {
		t.Fatal("partial initial snapshot was accepted")
	}
	unavailable, err := s.SearchIMSLP(ctx, "Prelude")
	if err != nil || unavailable.Status != "unavailable" || len(unavailable.Results) != 0 {
		t.Fatalf("failed initial state: %+v, %v", unavailable, err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("start") != "0" {
			t.Errorf("unexpected offset %s", r.URL.RawQuery)
		}
		fmt.Fprint(w, `{"0":{"id":"Prelude (Example, Ada)","type":"2","intvals":{"worktitle":"Prelude","composer":"Example, Ada"},"permlink":"https://imslp.org/wiki/Prelude_(Example,_Ada)"},"metadata":{"start":0,"limit":1000,"moreresultsavailable":false}}`)
	}))
	defer server.Close()
	if err := s.refreshIMSLPCatalog(ctx, server.Client(), server.URL+"?start=%d", 0, 1); err != nil {
		t.Fatal(err)
	}
	ready, err := s.SearchIMSLP(ctx, "example")
	if err != nil || ready.Status != "ready" || len(ready.Results) != 1 ||
		ready.Results[0].Composer != "Example, Ada" {
		t.Fatalf("ready state: %+v, %v", ready, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE imslp_catalog_state SET refreshed_at=now()-interval '8 days' WHERE id=TRUE`); err != nil {
		t.Fatal(err)
	}
	if err := s.refreshIMSLPCatalog(ctx, server.Client(), server.URL+"?start=%d", 0, 2); err == nil {
		t.Fatal("unexpectedly small complete refresh was accepted")
	}
	if err := s.refreshIMSLPCatalog(ctx, bad.Client(), bad.URL+"?start=%d", 0, 1); err == nil {
		t.Fatal("partial refresh was accepted")
	}
	retained, err := s.SearchIMSLP(ctx, "Prelude")
	if err != nil || retained.Status != "ready" || len(retained.Results) != 1 {
		t.Fatalf("old complete snapshot lost after failed refresh: %+v, %v", retained, err)
	}
	var generations int
	if err := pool.QueryRow(ctx, `SELECT count(DISTINCT generation) FROM imslp_catalog_works`).Scan(&generations); err != nil || generations != 1 {
		t.Fatalf("stale staging cleanup: count=%d err=%v", generations, err)
	}
	if !strings.HasPrefix(retained.Results[0].URL, "https://imslp.org/wiki/") {
		t.Fatal("untrusted work URL")
	}
}
