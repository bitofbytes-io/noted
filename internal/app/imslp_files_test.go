package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const quasiValseLocation = "//imslp.org/wiki/Quasi_valse,_Op.47_(Scriabin,_Aleksandr)#IMSLP02733"

var quasiValse = IMSLPWork{
	Title:    "Quasi valse, Op.47",
	Composer: "Scriabin, Aleksandr",
	URL:      "https://imslp.org/wiki/Quasi_valse,_Op.47_(Scriabin,_Aleksandr)",
}

func replyRedirect(location string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", location)
		w.WriteHeader(http.StatusFound)
	}
}

// testFileResolver is the search fixture with ReverseLookup served by the same fake.
func testFileResolver(t *testing.T, clock *fakeClock, adjust func(*IMSLPSearchConfig)) (*imslpSearcher, *fakeIMSLP) {
	t.Helper()
	return testIMSLPSearcher(t, clock, func(cfg *IMSLPSearchConfig) {
		cfg.WikiURL = strings.TrimSuffix(cfg.BaseURL, "api.php") + "wiki/"
		if adjust != nil {
			adjust(cfg)
		}
	})
}

func TestIMSLPFileNumberOf(t *testing.T) {
	for filename, want := range map[string]string{
		"IMSLP01240-Debussy_-_Suite_bergamasque_-_3_Clair_de_lune.pdf": "1240",
		"IMSLP02733-Scriabin_-_Quasi_valse.pdf":                        "2733",
		"IMSLP123456-x.pdf":                                            "123456",
		"IMSLP00000-x.pdf":                                             "0",
		"IMSLP12345678-x.pdf":                                          "12345678",
	} {
		if got, ok := imslpFileNumberOf(filename); !ok || got != want {
			t.Errorf("imslpFileNumberOf(%q) = %q, %v; want %q", filename, got, ok, want)
		}
	}
	for _, filename := range []string{
		"Clair de lune.pdf", "imslp01240-x.pdf", "IMSLP01240.pdf", "IMSLP-x.pdf",
		"IMSLP123456789-x.pdf", "copy of IMSLP01240-x.pdf", "IMSLPabc-x.pdf",
	} {
		if got, ok := imslpFileNumberOf(filename); ok {
			t.Errorf("imslpFileNumberOf(%q) = %q, want no number", filename, got)
		}
	}
}

func TestIMSLPWorkNameSplitsWorkAndComposer(t *testing.T) {
	for title, want := range map[string][2]string{
		"Clair de lune (Debussy, Claude)":          {"Clair de lune", "Debussy, Claude"},
		"Quasi valse, Op.47 (Scriabin, Aleksandr)": {"Quasi valse, Op.47", "Scriabin, Aleksandr"},
	} {
		if work, composer, ok := imslpWorkName(title); !ok || work != want[0] || composer != want[1] {
			t.Errorf("imslpWorkName(%q) = %q, %q, %v", title, work, composer, ok)
		}
	}
	for _, title := range []string{"Debussy", "(Debussy, Claude)", "Anthology (Various)", "Main Page"} {
		if _, _, ok := imslpWorkName(title); ok {
			t.Errorf("imslpWorkName(%q) accepted a non-work page", title)
		}
	}
}

func TestIMSLPResolveFileReadsReverseLookupRedirect(t *testing.T) {
	s, upstream := testFileResolver(t, newFakeClock(), nil)
	var got *http.Request
	upstream.set(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(context.Background())
		replyRedirect(quasiValseLocation)(w, r)
	})
	work, ok := s.resolveFile("2733")
	if !ok || work != quasiValse {
		t.Fatalf("resolved %+v, %v", work, ok)
	}
	if got.URL.Path != "/wiki/Special:ReverseLookup/2733" || !strings.HasPrefix(got.UserAgent(), "Noted/") {
		t.Fatalf("request %s with agent %q", got.URL.Path, got.UserAgent())
	}
	if upstream.hits.Load() != 1 {
		t.Fatalf("the work page was fetched: hits=%d", upstream.hits.Load())
	}

	for location, want := range map[string]string{
		"/wiki/Clair_de_lune_(Debussy,_Claude)#IMSLP01240":                   "https://imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)",
		"https://imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)":             "https://imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)",
		"http://imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)":              "https://imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)",
		"//imslp.org/wiki/F%C3%AAtes_galantes_(Debussy,_Claude)#IMSLP1":      "https://imslp.org/wiki/F%C3%AAtes_galantes_(Debussy,_Claude)",
		"//imslp.org/wiki/'Who_are_We?'_from_Psalm_8_(Ludtke,_William_G.)#x": "https://imslp.org/wiki/'Who_are_We%3F'_from_Psalm_8_(Ludtke,_William_G.)",
	} {
		work, ok := imslpWorkFromLocation(location)
		if !ok || work.URL != want || !validIMSLPWorkURL(work.URL) {
			t.Errorf("Location %q → %+v, %v; want %q", location, work, ok, want)
		}
	}
	if work, _ := imslpWorkFromLocation("//imslp.org/wiki/F%C3%AAtes_galantes_(Debussy,_Claude)"); work.Title != "Fêtes galantes" {
		t.Errorf("encoded title was not decoded: %+v", work)
	}
}

func TestIMSLPResolveFileFindsNoWorkForOtherAnswers(t *testing.T) {
	redirectTargetHits := atomic.Int32{}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectTargetHits.Add(1)
		replyRedirect(quasiValseLocation)(w, r)
	}))
	defer target.Close()
	for name, test := range map[string]struct {
		reply   http.HandlerFunc
		failure bool
	}{
		"302 to another site":    {replyRedirect(target.URL + "/wiki/Quasi_valse_(Scriabin,_Aleksandr)"), true},
		"302 to a non-work page": {replyRedirect("//imslp.org/wiki/Main_Page"), true},
		"302 to a special page":  {replyRedirect("/index.php?title=Special:Captcha"), true},
		"302 without a location": {func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusFound) }, true},
		"200 page":               {replyJSON("<html>No file</html>"), false},
		"404":                    {func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }, false},
		"5xx":                    {func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) }, true},
		"timeout": {func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-r.Context().Done():
			case <-time.After(2 * time.Second):
			}
		}, true},
	} {
		t.Run(name, func(t *testing.T) {
			s, upstream := testFileResolver(t, newFakeClock(), nil)
			upstream.set(test.reply)
			if work, ok := s.resolveFile("2733"); ok {
				t.Fatalf("resolved %+v", work)
			}
			if failures := map[bool]int{true: 1, false: 0}[test.failure]; s.failures != failures || s.open {
				t.Fatalf("breaker after %s: failures=%d open=%v", name, s.failures, s.open)
			}
			// A miss is not cached: the next lookup asks IMSLP again.
			s.resolveFile("2733")
			if upstream.hits.Load() != 2 {
				t.Fatalf("a miss was cached: hits=%d", upstream.hits.Load())
			}
		})
	}
	if redirectTargetHits.Load() != 0 {
		t.Fatal("redirect was followed")
	}
}

func TestIMSLPResolveFileCachesWorksForADay(t *testing.T) {
	clock := newFakeClock()
	s, upstream := testFileResolver(t, clock, func(cfg *IMSLPSearchConfig) { cfg.FileCacheSize = 2 })
	upstream.set(replyRedirect(quasiValseLocation))
	s.resolveFile("2733")
	if work, ok := s.resolveFile("2733"); !ok || work != quasiValse || upstream.hits.Load() != 1 {
		t.Fatalf("cache hit sent a request: %+v %v hits=%d", work, ok, upstream.hits.Load())
	}
	clock.Advance(24*time.Hour - time.Second)
	s.resolveFile("2733")
	if upstream.hits.Load() != 1 {
		t.Fatalf("cache expired early: hits=%d", upstream.hits.Load())
	}
	clock.Advance(time.Second)
	s.resolveFile("2733")
	if upstream.hits.Load() != 2 {
		t.Fatalf("24 h expiry did not refresh: hits=%d", upstream.hits.Load())
	}

	// LRU: 2733 is the most recent, so a third number evicts 1.
	s.resolveFile("1")
	s.resolveFile("2733")
	s.resolveFile("2")
	before := upstream.hits.Load()
	s.resolveFile("2733")
	if upstream.hits.Load() != before {
		t.Fatal("recently used file was evicted")
	}
	s.resolveFile("1")
	if upstream.hits.Load() != before+1 {
		t.Fatal("least recently used file was kept")
	}

	// File lookups never share entries with work search.
	upstream.set(replyJSON(clairDeLunePage))
	if result := mustSearch(t, s, "2733"); result.Status != IMSLPStatusReady || len(result.Results) != 1 {
		t.Fatalf("search after a file lookup: %+v", result)
	}
}

func TestIMSLPResolveFileSharesBreakerAndOutboundLimit(t *testing.T) {
	clock := newFakeClock()
	s, upstream := testFileResolver(t, clock, nil)
	upstream.set(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) })
	for i := range 3 {
		mustSearch(t, s, fmt.Sprintf("query %d", i))
	}
	if !s.open {
		t.Fatal("three search failures did not open the breaker")
	}
	upstream.set(replyRedirect(quasiValseLocation))
	if work, ok := s.resolveFile("2733"); ok || upstream.hits.Load() != 3 {
		t.Fatalf("open breaker let a lookup through: %+v hits=%d", work, upstream.hits.Load())
	}
	clock.Advance(60 * time.Second)
	if work, ok := s.resolveFile("2733"); !ok || work != quasiValse || s.open {
		t.Fatalf("half-open probe by a file lookup: %+v open=%v", work, s.open)
	}

	// File lookup failures count toward the same breaker that pauses search.
	upstream.set(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) })
	for i := range 3 {
		s.resolveFile(fmt.Sprint(100 + i))
	}
	before := upstream.hits.Load()
	if result := mustSearch(t, s, "Clair de lune"); result.Status != IMSLPStatusUnavailable || upstream.hits.Load() != before {
		t.Fatalf("search after three failed file lookups: %+v hits=%d", result, upstream.hits.Load())
	}

	limited, limitedUpstream := testFileResolver(t, newFakeClock(), func(cfg *IMSLPSearchConfig) {
		cfg.OutboundRate, cfg.OutboundBurst = 0.25, 1
	})
	mustSearch(t, limited, "one")
	limitedUpstream.set(replyRedirect(quasiValseLocation))
	if _, ok := limited.resolveFile("2733"); ok || limitedUpstream.hits.Load() != 1 {
		t.Fatalf("file lookup skipped the shared outbound limit: hits=%d", limitedUpstream.hits.Load())
	}
}

func TestIMSLPResolveFileHonoursRetryAfter(t *testing.T) {
	clock := newFakeClock()
	s, upstream := testFileResolver(t, clock, nil)
	upstream.set(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	})
	if _, ok := s.resolveFile("2733"); ok || !s.open {
		t.Fatalf("upstream 429 did not pause lookups: open=%v", s.open)
	}
	upstream.set(replyRedirect(quasiValseLocation))
	clock.Advance(29 * time.Second)
	if _, ok := s.resolveFile("2733"); ok || upstream.hits.Load() != 1 {
		t.Fatalf("called IMSLP during Retry-After: hits=%d", upstream.hits.Load())
	}
	clock.Advance(time.Second)
	if _, ok := s.resolveFile("2733"); !ok {
		t.Fatal("lookup after Retry-After")
	}
}
