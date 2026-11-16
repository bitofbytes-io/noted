package app

import (
	"reflect"
	"testing"
	"time"
)

func TestIMSLPSearchCachesNormalisedQueries(t *testing.T) {
	clock := newFakeClock()
	s, upstream := testIMSLPSearcher(t, clock, nil)
	first := mustSearch(t, s, "Clair de Lune")
	second := mustSearch(t, s, "  clair   DE lune")
	if upstream.hits.Load() != 1 || !reflect.DeepEqual(first, second) {
		t.Fatalf("cache hit sent another request: hits=%d", upstream.hits.Load())
	}
	clock.Advance(20*time.Minute - time.Second)
	mustSearch(t, s, "clair de lune")
	if upstream.hits.Load() != 1 {
		t.Fatalf("cache expired early: hits=%d", upstream.hits.Load())
	}
	clock.Advance(time.Second)
	mustSearch(t, s, "clair de lune")
	if upstream.hits.Load() != 2 {
		t.Fatalf("TTL expiry did not refresh: hits=%d", upstream.hits.Load())
	}

	upstream.set(replyJSON(`{"batchcomplete":true}`))
	if result := mustSearch(t, s, "Debusy Claire de loon"); result.Status != IMSLPStatusReady || len(result.Results) != 0 {
		t.Fatalf("no matches: %+v", result)
	}
	clock.Advance(5*time.Minute - time.Second)
	mustSearch(t, s, "debusy claire de loon")
	// An empty title search also tried text mode: two requests per lookup.
	if upstream.hits.Load() != 4 {
		t.Fatalf("negative result was not cached: hits=%d", upstream.hits.Load())
	}
	clock.Advance(time.Second)
	mustSearch(t, s, "debusy claire de loon")
	if upstream.hits.Load() != 6 {
		t.Fatalf("negative result outlived its TTL: hits=%d", upstream.hits.Load())
	}
}

func TestIMSLPSearchCacheEvictsLeastRecentlyUsed(t *testing.T) {
	s, upstream := testIMSLPSearcher(t, newFakeClock(), func(cfg *IMSLPSearchConfig) { cfg.CacheSize = 2 })
	mustSearch(t, s, "one")
	mustSearch(t, s, "two")
	mustSearch(t, s, "one")
	mustSearch(t, s, "three")
	mustSearch(t, s, "one")
	if upstream.hits.Load() != 3 {
		t.Fatalf("recently used entry was evicted: hits=%d", upstream.hits.Load())
	}
	mustSearch(t, s, "two")
	if upstream.hits.Load() != 4 {
		t.Fatalf("least recently used entry was kept: hits=%d", upstream.hits.Load())
	}
}
