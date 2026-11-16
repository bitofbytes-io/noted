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
		fmt.Fprint(w, body) //nolint:errcheck // Timeout/cancellation tests may close this fake upstream response.
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
		result, err := s.search(context.Background(), "user-a", "Clair de lune")
		if err != nil {
			t.Error(err)
		}
		results <- result
	}()
	<-started
	go func() {
		result, err := s.search(context.Background(), "user-b", "clair de lune")
		if err != nil {
			t.Error(err)
		}
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
