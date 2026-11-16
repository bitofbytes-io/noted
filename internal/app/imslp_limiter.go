package app

import (
	"context"
	"log/slog"
	"time"
)

// admit applies the circuit breaker. After the cooldown exactly one probe is
// let through; its outcome closes the breaker or keeps it open.
func (s *imslpSearcher) admit() (probe, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.open {
		return false, true
	}
	if s.cfg.Now().Before(s.openUntil) || s.probing {
		return false, false
	}
	s.probing = true
	return true, true
}

func (s *imslpSearcher) abandonProbe(probe bool) {
	if !probe {
		return
	}
	s.mu.Lock()
	s.probing = false
	s.mu.Unlock()
}

func (s *imslpSearcher) record(probe bool, err error, retryAfter time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if probe {
		s.probing = false
	}
	if err == nil {
		// Only the half-open probe may close an open breaker: a request admitted
		// before it opened says nothing about the cooldown or Retry-After.
		if s.open && !probe {
			return
		}
		s.failures = 0
		if s.open {
			s.open = false
			slog.Info("IMSLP search resumed")
		}
		return
	}
	s.failures++
	if !s.open && s.failures < s.cfg.BreakerFailures && retryAfter == 0 {
		return
	}
	cooldown := s.cfg.BreakerCooldown
	if retryAfter > 0 {
		cooldown = retryAfter
	}
	if !s.open {
		slog.Warn("IMSLP search paused after upstream failures", "error", err, "pause", cooldown)
	}
	s.open = true
	if until := s.cfg.Now().Add(cooldown); until.After(s.openUntil) {
		s.openUntil = until
	}
}

// acquireOutbound shares IMSLP's request budget across all users. A request
// that would wait longer than OutboundMaxWait is refused without calling IMSLP.
func (s *imslpSearcher) acquireOutbound() (func(), bool) {
	s.mu.Lock()
	wait, ok := s.outbound.reserve(s.cfg.Now(), s.cfg.OutboundRate, s.cfg.OutboundBurst, s.cfg.OutboundMaxWait)
	s.mu.Unlock()
	if !ok {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.OutboundMaxWait)
	defer cancel()
	// A request that never goes out hands its token back.
	refund := func() (func(), bool) {
		s.mu.Lock()
		s.outbound.refund(s.cfg.OutboundBurst)
		s.mu.Unlock()
		return nil, false
	}
	if wait > 0 {
		if err := s.cfg.Sleep(ctx, wait); err != nil {
			return refund()
		}
	}
	select {
	case s.slots <- struct{}{}:
		return func() { <-s.slots }, true
	case <-ctx.Done():
		return refund()
	}
}
