package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// fakeIMSLP stands in for imslp.org/api.php. Each test swaps its reply.
type fakeIMSLP struct {
	hits  atomic.Int32
	mu    sync.Mutex
	reply http.HandlerFunc
}

func (f *fakeIMSLP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.hits.Add(1)
	f.mu.Lock()
	reply := f.reply
	f.mu.Unlock()
	reply(w, r)
}

func (f *fakeIMSLP) set(reply http.HandlerFunc) {
	f.mu.Lock()
	f.reply = reply
	f.mu.Unlock()
}

const clairDeLunePage = `{"batchcomplete":true,"query":{"pages":[{"pageid":1,"ns":0,"title":"Clair de lune (Debussy, Claude)","index":1,"fullurl":"//imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)"}]}}`

func replyJSON(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, body)
	}
}

func testIMSLPSearcher(t *testing.T, clock *fakeClock, adjust func(*IMSLPSearchConfig)) (*imslpSearcher, *fakeIMSLP) {
	t.Helper()
	upstream := &fakeIMSLP{reply: replyJSON(clairDeLunePage)}
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = 200 * time.Millisecond
	cfg := IMSLPSearchConfig{
		BaseURL:   server.URL + "/api.php",
		Client:    client,
		Now:       clock.Now,
		Sleep:     func(_ context.Context, d time.Duration) error { clock.Advance(d); return nil },
		UserRate:  1000,
		UserBurst: 1000,
	}
	if adjust != nil {
		adjust(&cfg)
	}
	return newIMSLPSearcher(cfg), upstream
}

func mustSearch(t *testing.T, s *imslpSearcher, query string) IMSLPSearch {
	t.Helper()
	result, err := s.search(context.Background(), "user-a", query)
	if err != nil {
		t.Fatalf("search %q: %v", query, err)
	}
	return result
}

func TestParseIMSLPSearchKeepsRankedWorkPages(t *testing.T) {
	// The shape IMSLP's MediaWiki 1.18 returns: pages keyed by id in title order,
	// rank only in list=search, and a ranked redirect collapsed onto its target.
	body := `{"query-continue":{"search":{"sroffset":10}},"query":{
		"search":[
			{"ns":0,"title":"Clair de Lune (Debussy, Claude)"},
			{"ns":0,"title":"'Who are We?' from Psalm 8 (Ludtke, William G.)"},
			{"ns":0,"title":"Debussy"},
			{"ns":0,"title":"Clair de lune (Debussy, Claude)"},
			{"ns":0,"title":"F\u00eates galantes (Debussy, Claude)"}
		],
		"redirects":[{"from":"Clair de Lune (Debussy, Claude)","to":"Clair de lune (Debussy, Claude)"}],
		"pages":{
			"104":{"pageid":104,"ns":0,"title":"'Who are We?' from Psalm 8 (Ludtke, William G.)","fullurl":"\/\/imslp.org\/wiki\/'Who_are_We?'_from_Psalm_8_(Ludtke,_William_G.)"},
			"101":{"pageid":101,"ns":0,"title":"Clair de lune (Debussy, Claude)","fullurl":"\/\/imslp.org\/wiki\/Clair_de_lune_(Debussy,_Claude)"},
			"105":{"pageid":105,"ns":0,"title":"Debussy","fullurl":"\/\/imslp.org\/wiki\/Debussy"},
			"106":{"pageid":106,"ns":0,"title":"Elsewhere (Example, Ada)","fullurl":"\/\/evil.example\/wiki\/Elsewhere_(Example,_Ada)"},
			"103":{"pageid":103,"ns":0,"title":"F\u00eates galantes (Debussy, Claude)","fullurl":"\/\/imslp.org\/wiki\/F%C3%AAtes_galantes_(Debussy,_Claude)"},
			"-1":{"ns":0,"title":"Gone (Example, Ada)","missing":"","fullurl":"\/\/imslp.org\/wiki\/Gone_(Example,_Ada)"}
		}}}`
	works, err := parseIMSLPSearch(strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	want := []IMSLPWork{
		{Title: "Clair de lune", Composer: "Debussy, Claude", URL: "https://imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)"},
		{Title: "'Who are We?' from Psalm 8", Composer: "Ludtke, William G.", URL: "https://imslp.org/wiki/'Who_are_We%3F'_from_Psalm_8_(Ludtke,_William_G.)"},
		{Title: "Fêtes galantes", Composer: "Debussy, Claude", URL: "https://imslp.org/wiki/F%C3%AAtes_galantes_(Debussy,_Claude)"},
	}
	if !reflect.DeepEqual(works, want) {
		t.Fatalf("parsed works:\n got %+v\nwant %+v", works, want)
	}
	for _, work := range works {
		if !validIMSLPWorkURL(work.URL) {
			t.Fatalf("untrusted work URL %q", work.URL)
		}
	}

	// A newer MediaWiki honours formatversion=2: a page array ranked by index.
	current := `{"batchcomplete":true,"query":{"pages":[
		{"ns":0,"title":"Suite bergamasque (Debussy, Claude)","index":2,"fullurl":"https://imslp.org/wiki/Suite_bergamasque_(Debussy,_Claude)"},
		{"ns":0,"title":"Clair de lune (Debussy, Claude)","index":1,"fullurl":"//imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)"},
		{"ns":14,"title":"Category:Debussy (Debussy, Claude)","index":3,"fullurl":"//imslp.org/wiki/Category:Debussy"}
	]}}`
	works, err = parseIMSLPSearch(strings.NewReader(current))
	if err != nil || len(works) != 2 || works[0].Title != "Clair de lune" || works[1].Title != "Suite bergamasque" {
		t.Fatalf("formatversion=2 reply: %+v, %v", works, err)
	}

	for _, empty := range []string{`{"batchcomplete":true}`, `{"query":{"search":[]}}`} {
		works, err := parseIMSLPSearch(strings.NewReader(empty))
		if err != nil || works == nil || len(works) != 0 {
			t.Fatalf("no-hit response %s: %+v, %v", empty, works, err)
		}
	}
	for _, bad := range []string{`<html>`, `{"error":{"code":"badparam"}}`, `{"query":{"pages":"x"}}`} {
		if _, err := parseIMSLPSearch(strings.NewReader(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}

func TestCanonicalIMSLPWorkURLPreservesQuestionMarkInTitle(t *testing.T) {
	url, ok := canonicalIMSLPWorkURL("https://imslp.org/wiki/'Who_are_We?'_from_Psalm_8_(Ludtke,_William_G.)")
	if !ok || !strings.Contains(url, "We%3F'") || !validIMSLPWorkURL(url) {
		t.Fatalf("wiki title was not preserved: %q, valid=%v", url, ok)
	}
}

func TestIMSLPSearchQueriesGeneratorSearch(t *testing.T) {
	s, upstream := testIMSLPSearcher(t, newFakeClock(), nil)
	var got *http.Request
	upstream.set(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(context.Background())
		replyJSON(clairDeLunePage)(w, r)
	})
	result := mustSearch(t, s, "  Debussy   Clair de LUNE ")
	if result.Status != IMSLPStatusReady || len(result.Results) != 1 || result.Results[0].Composer != "Debussy, Claude" {
		t.Fatalf("result: %+v", result)
	}
	query := got.URL.Query()
	for key, want := range map[string]string{
		"action": "query", "format": "json", "formatversion": "2",
		"list": "search", "srsearch": "debussy* clair* de lune*", "srnamespace": "0", "srlimit": "10", "srwhat": "title",
		"generator": "search",
		"gsrsearch": "debussy* clair* de lune*", "gsrnamespace": "0", "gsrlimit": "10", "gsrwhat": "title",
		"redirects": "1", "prop": "info", "inprop": "url",
	} {
		if query.Get(key) != want {
			t.Errorf("%s = %q, want %q", key, query.Get(key), want)
		}
	}
	if got.URL.Path != "/api.php" || !strings.HasPrefix(got.UserAgent(), "Noted/") {
		t.Fatalf("request %s with agent %q", got.URL.Path, got.UserAgent())
	}
}

func TestIMSLPSearchTermsUsePrefixWildcards(t *testing.T) {
	for query, want := range map[string]string{
		"satie gymnop":               "satie* gymnop*",
		"chopin no":                  "chopin* no",
		"rachmaninoff prelude op.23": "rachmaninoff* prelude* op.23*",
		"gymnopédies":                "gymnopédies*",
		"d'indy":                     "d'indy*",
		"édu":                        "édu",
		`"clair" +de* ~lune (x) <y>`: "clair* de lune* x y",
		"-debussy --moon -to":        "debussy* moon* to",
		"( ) * -":                    "",
	} {
		if got := imslpSearchTerms(query); got != want {
			t.Errorf("imslpSearchTerms(%q) = %q, want %q", query, got, want)
		}
	}
}

func TestIMSLPSearchFallsBackToTextWhenTitlesMatchNothing(t *testing.T) {
	clock := newFakeClock()
	s, upstream := testIMSLPSearcher(t, clock, nil)
	var mu sync.Mutex
	var modes []string
	upstream.set(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		mu.Lock()
		modes = append(modes, query.Get("srwhat")+"/"+query.Get("gsrwhat"))
		mu.Unlock()
		if query.Get("srwhat") == "title" && strings.Contains(query.Get("srsearch"), "moonlight") {
			replyJSON(`{"query":{"search":[]}}`)(w, r)
			return
		}
		replyJSON(clairDeLunePage)(w, r)
	})
	result := mustSearch(t, s, "beethoven moonlight")
	if result.Status != IMSLPStatusReady || len(result.Results) != 1 {
		t.Fatalf("fallback result: %+v", result)
	}
	if !reflect.DeepEqual(modes, []string{"title/title", "text/text"}) {
		t.Fatalf("request modes = %v", modes)
	}
	mustSearch(t, s, "Beethoven  Moonlight")
	if upstream.hits.Load() != 2 {
		t.Fatalf("fallback result was not cached: hits=%d", upstream.hits.Load())
	}
	clock.Advance(20 * time.Minute)
	mustSearch(t, s, "beethoven moonlight")
	if upstream.hits.Load() != 4 {
		t.Fatalf("expired fallback result was not refreshed: hits=%d", upstream.hits.Load())
	}

	modes = nil
	mustSearch(t, s, "clair de lune")
	if !reflect.DeepEqual(modes, []string{"title/title"}) {
		t.Fatalf("a title match still fell back: %v", modes)
	}
}

func TestIMSLPSearchWithoutTermsSendsNothing(t *testing.T) {
	s, upstream := testIMSLPSearcher(t, newFakeClock(), nil)
	if result := mustSearch(t, s, "( )"); result.Status != IMSLPStatusReady || len(result.Results) != 0 {
		t.Fatalf("operator-only query: %+v", result)
	}
	if upstream.hits.Load() != 0 {
		t.Fatalf("operator-only query reached IMSLP: hits=%d", upstream.hits.Load())
	}
}

func TestIMSLPSearchUpstreamFailuresAreUnavailable(t *testing.T) {
	redirectTargetHits := atomic.Int32{}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectTargetHits.Add(1)
		replyJSON(clairDeLunePage)(w, r)
	}))
	defer target.Close()
	for name, reply := range map[string]http.HandlerFunc{
		"5xx": func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) },
		"browser check redirect": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, target.URL, http.StatusFound)
		},
		"malformed JSON": replyJSON(`{"query":`),
		"timeout": func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-r.Context().Done():
			case <-time.After(2 * time.Second):
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			s, upstream := testIMSLPSearcher(t, newFakeClock(), nil)
			upstream.set(reply)
			result := mustSearch(t, s, "Clair de lune")
			if result.Status != IMSLPStatusUnavailable || result.Results == nil || len(result.Results) != 0 {
				t.Fatalf("result: %+v", result)
			}
			if s.failures != 1 || s.open {
				t.Fatalf("one failure must not open the breaker: failures=%d open=%v", s.failures, s.open)
			}
		})
	}
	if redirectTargetHits.Load() != 0 {
		t.Fatal("redirect was followed")
	}
}

func TestIMSLPSearchBreakerOpensAfterThreeFailuresAndProbesAfterCooldown(t *testing.T) {
	clock := newFakeClock()
	s, upstream := testIMSLPSearcher(t, clock, nil)
	upstream.set(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) })
	for i := range 3 {
		if result := mustSearch(t, s, fmt.Sprintf("query %d", i)); result.Status != IMSLPStatusUnavailable {
			t.Fatalf("failure %d: %+v", i, result)
		}
	}
	if upstream.hits.Load() != 3 || !s.open {
		t.Fatalf("breaker after three failures: hits=%d open=%v", upstream.hits.Load(), s.open)
	}
	upstream.set(replyJSON(clairDeLunePage))
	if result := mustSearch(t, s, "Clair de lune"); result.Status != IMSLPStatusUnavailable || upstream.hits.Load() != 3 {
		t.Fatalf("open breaker called IMSLP: %+v hits=%d", result, upstream.hits.Load())
	}
	clock.Advance(59 * time.Second)
	if result := mustSearch(t, s, "Clair de lune"); result.Status != IMSLPStatusUnavailable || upstream.hits.Load() != 3 {
		t.Fatalf("breaker probed early: %+v hits=%d", result, upstream.hits.Load())
	}
	clock.Advance(time.Second)
	if result := mustSearch(t, s, "Clair de lune"); result.Status != IMSLPStatusReady || upstream.hits.Load() != 4 {
		t.Fatalf("half-open probe: %+v hits=%d", result, upstream.hits.Load())
	}
	if s.open || s.failures != 0 {
		t.Fatalf("successful probe did not close the breaker: open=%v failures=%d", s.open, s.failures)
	}
	if result := mustSearch(t, s, "Nocturne"); result.Status != IMSLPStatusReady || upstream.hits.Load() != 5 {
		t.Fatalf("closed breaker: %+v hits=%d", result, upstream.hits.Load())
	}
}

func TestIMSLPSearchFailedProbeReopensBreaker(t *testing.T) {
	clock := newFakeClock()
	s, upstream := testIMSLPSearcher(t, clock, nil)
	upstream.set(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) })
	for i := range 3 {
		mustSearch(t, s, fmt.Sprintf("query %d", i))
	}
	clock.Advance(60 * time.Second)
	mustSearch(t, s, "probe")
	mustSearch(t, s, "after probe")
	if upstream.hits.Load() != 4 || !s.open {
		t.Fatalf("failed probe: hits=%d open=%v", upstream.hits.Load(), s.open)
	}
}

func TestIMSLPSearchHonoursUpstreamRetryAfter(t *testing.T) {
	clock := newFakeClock()
	s, upstream := testIMSLPSearcher(t, clock, nil)
	upstream.set(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	})
	if result := mustSearch(t, s, "Clair de lune"); result.Status != IMSLPStatusUnavailable || !s.open {
		t.Fatalf("upstream 429: %+v open=%v", result, s.open)
	}
	upstream.set(replyJSON(clairDeLunePage))
	clock.Advance(29 * time.Second)
	if mustSearch(t, s, "Clair de lune"); upstream.hits.Load() != 1 {
		t.Fatalf("called IMSLP during Retry-After: hits=%d", upstream.hits.Load())
	}
	clock.Advance(time.Second)
	if result := mustSearch(t, s, "Clair de lune"); result.Status != IMSLPStatusReady || upstream.hits.Load() != 2 {
		t.Fatalf("after Retry-After: %+v hits=%d", result, upstream.hits.Load())
	}

	if got := s.retryAfter("3600"); got != 60*time.Second {
		t.Fatalf("Retry-After cap = %v", got)
	}
	if got := s.retryAfter(""); got != 60*time.Second {
		t.Fatalf("missing Retry-After = %v", got)
	}
	date := clock.Now().Add(10 * time.Second).UTC().Format(http.TimeFormat)
	if got := s.retryAfter(date); got != 10*time.Second {
		t.Fatalf("HTTP-date Retry-After = %v", got)
	}
}

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

func TestIMSLPSearchPerUserLimit(t *testing.T) {
	clock := newFakeClock()
	s, upstream := testIMSLPSearcher(t, clock, func(cfg *IMSLPSearchConfig) {
		cfg.UserRate, cfg.UserBurst = 0, 0
	})
	for i := range 4 {
		if _, err := s.search(context.Background(), "user-a", "Clair de lune"); err != nil {
			t.Fatalf("burst request %d: %v", i, err)
		}
	}
	if _, err := s.search(context.Background(), "user-a", "Clair de lune"); !errors.Is(err, ErrIMSLPThrottled) {
		t.Fatalf("fifth request in a burst: %v", err)
	}
	if _, err := s.search(context.Background(), "user-b", "Clair de lune"); err != nil {
		t.Fatalf("another user was throttled: %v", err)
	}
	clock.Advance(500 * time.Millisecond)
	if _, err := s.search(context.Background(), "user-a", "Clair de lune"); err != nil {
		t.Fatalf("token did not refill at 2/s: %v", err)
	}
	if upstream.hits.Load() != 1 {
		t.Fatalf("throttled or cached searches reached IMSLP: hits=%d", upstream.hits.Load())
	}
	clock.Advance(10 * time.Minute)
	mustSearch(t, s, "Clair de lune")
	s.mu.Lock()
	_, idleKept := s.users["user-b"]
	s.mu.Unlock()
	if idleKept {
		t.Fatal("idle user limiter was not expired")
	}
}

func TestIMSLPSearchOutboundLimitRefusesLongWaits(t *testing.T) {
	clock := newFakeClock()
	s, upstream := testIMSLPSearcher(t, clock, func(cfg *IMSLPSearchConfig) {
		cfg.OutboundRate, cfg.OutboundBurst = 0.25, 1
	})
	mustSearch(t, s, "one")
	if result := mustSearch(t, s, "two"); result.Status != IMSLPStatusUnavailable || upstream.hits.Load() != 1 {
		t.Fatalf("four-second wait was not refused: %+v hits=%d", result, upstream.hits.Load())
	}
	if s.failures != 0 {
		t.Fatal("a local wait limit counted as an upstream failure")
	}
	clock.Advance(3 * time.Second)
	before := clock.Now()
	if result := mustSearch(t, s, "two"); result.Status != IMSLPStatusReady || upstream.hits.Load() != 2 {
		t.Fatalf("short wait: %+v hits=%d", result, upstream.hits.Load())
	}
	if waited := clock.Now().Sub(before); waited != time.Second {
		t.Fatalf("waited %v for the next outbound token", waited)
	}
}

func TestIMSLPSearchSharesConcurrentIdenticalQueries(t *testing.T) {
	s, upstream := testIMSLPSearcher(t, newFakeClock(), nil)
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	upstream.set(func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() { close(started) })
		<-release
		replyJSON(clairDeLunePage)(w, r)
	})
	cancelled, cancel := context.WithCancel(context.Background())
	results := make(chan IMSLPSearch, 2)
	errs := make(chan error, 1)
	go func() {
		result, _ := s.search(context.Background(), "user-a", "Clair de lune")
		results <- result
	}()
	<-started
	go func() {
		result, _ := s.search(context.Background(), "user-b", "clair de lune")
		results <- result
	}()
	go func() {
		_, err := s.search(cancelled, "user-c", "Clair de lune")
		errs <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-errs; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled caller: %v", err)
	}
	close(release)
	for range 2 {
		if result := <-results; result.Status != IMSLPStatusReady || len(result.Results) != 1 {
			t.Fatalf("shared result: %+v", result)
		}
	}
	if upstream.hits.Load() != 1 {
		t.Fatalf("identical concurrent queries made %d upstream requests", upstream.hits.Load())
	}
}

func TestServiceSearchIMSLPValidatesQueryLength(t *testing.T) {
	s := NewService(nil, nil)
	for _, query := range []string{"", " x ", strings.Repeat("a", 101)} {
		if _, err := s.SearchIMSLP(context.Background(), "user-a", query); err == nil {
			t.Fatalf("accepted %q", query)
		}
	}
}
