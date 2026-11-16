package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

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

func TestIMSLPSearchLateSuccessDoesNotCloseOpenBreaker(t *testing.T) {
	clock := newFakeClock()
	s, upstream := testIMSLPSearcher(t, clock, func(cfg *IMSLPSearchConfig) {
		cfg.Client.Timeout = 5 * time.Second
	})
	started, release := make(chan struct{}), make(chan struct{})
	healthy := atomic.Bool{}
	upstream.set(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Query().Get("srsearch"), "slow") {
			close(started)
			<-release
			replyJSON(clairDeLunePage)(w, r)
			return
		}
		if healthy.Load() {
			replyJSON(clairDeLunePage)(w, r)
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	})
	late := make(chan IMSLPSearch, 1)
	go func() {
		result, err := s.search(context.Background(), "user-a", "slow query")
		if err != nil {
			t.Error(err)
		}
		late <- result
	}()
	<-started
	for i := range 3 {
		mustSearch(t, s, fmt.Sprintf("query %d", i))
	}
	if !s.open {
		t.Fatal("three failures did not open the breaker")
	}
	close(release)
	if result := <-late; result.Status != IMSLPStatusReady {
		t.Fatalf("in-flight request: %+v", result)
	}
	if !s.open || s.failures != 3 {
		t.Fatalf("a pre-admitted success closed the breaker: open=%v failures=%d", s.open, s.failures)
	}
	healthy.Store(true)
	before := upstream.hits.Load()
	if result := mustSearch(t, s, "Clair de lune"); result.Status != IMSLPStatusUnavailable || upstream.hits.Load() != before {
		t.Fatalf("breaker let a request through during cooldown: %+v", result)
	}
	clock.Advance(60 * time.Second)
	if result := mustSearch(t, s, "Clair de lune"); result.Status != IMSLPStatusReady || s.open {
		t.Fatalf("probe after cooldown: %+v open=%v", result, s.open)
	}
}

func TestIMSLPSearchRefundsOutboundTokenWhenSlotWaitTimesOut(t *testing.T) {
	s, upstream := testIMSLPSearcher(t, newFakeClock(), func(cfg *IMSLPSearchConfig) {
		cfg.Client.Timeout = 5 * time.Second
		cfg.OutboundRate, cfg.OutboundBurst, cfg.OutboundConcurrency = 1, 2, 1
		cfg.OutboundMaxWait = 50 * time.Millisecond
	})
	started, release := make(chan struct{}), make(chan struct{})
	upstream.set(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Query().Get("srsearch"), "slow") {
			close(started)
			<-release
		}
		replyJSON(clairDeLunePage)(w, r)
	})
	done := make(chan struct{})
	go func() {
		mustSearch(t, s, "slow query")
		close(done)
	}()
	<-started
	// The only slot is busy: this caller takes the second token, then times out.
	if result := mustSearch(t, s, "waiting"); result.Status != IMSLPStatusUnavailable {
		t.Fatalf("slot wait: %+v", result)
	}
	close(release)
	<-done
	// The fake clock has not moved, so only a refunded token lets this through.
	if result := mustSearch(t, s, "next"); result.Status != IMSLPStatusReady {
		t.Fatalf("token lost by the timed-out caller: %+v", result)
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
	s.users.mu.Lock()
	_, idleKept := s.users.users["user-b"]
	s.users.mu.Unlock()
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
