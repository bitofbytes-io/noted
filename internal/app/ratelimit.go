package app

import (
	"math"
	"sync"
	"time"
)

// tokenBucket is a plain token bucket; a new bucket starts full.
type tokenBucket struct {
	tokens float64
	last   time.Time
}

func (b *tokenBucket) refill(now time.Time, rate float64, burst int) {
	if b.last.IsZero() {
		b.tokens, b.last = float64(burst), now
		return
	}
	if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens = math.Min(float64(burst), b.tokens+elapsed.Seconds()*rate)
		b.last = now
	}
}

func (b *tokenBucket) allow(now time.Time, rate float64, burst int) bool {
	b.refill(now, rate, burst)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// reserve takes a token now or in the future and returns how long to wait for
// it. When that wait would exceed maxWait nothing is taken.
func (b *tokenBucket) reserve(now time.Time, rate float64, burst int, maxWait time.Duration) (time.Duration, bool) {
	b.refill(now, rate, burst)
	var wait time.Duration
	if b.tokens < 1 {
		wait = time.Duration((1 - b.tokens) / rate * float64(time.Second))
	}
	if wait > maxWait {
		return 0, false
	}
	b.tokens--
	return wait, true
}

// refund returns a token taken by reserve for a request that was never made.
func (b *tokenBucket) refund(burst int) {
	b.tokens = math.Min(float64(burst), b.tokens+1)
}

// userLimiter is a token bucket per user. A user's bucket is dropped once it
// has been idle for the idle period, so the map does not grow without bound.
// IMSLP search and Send to Noted each keep their own.
type userLimiter struct {
	rate  float64
	burst int
	idle  time.Duration
	now   func() time.Time

	mu        sync.Mutex
	users     map[string]*userBucket
	nextSweep time.Time
}

type userBucket struct {
	bucket tokenBucket
	seen   time.Time
}

func newUserLimiter(rate float64, burst int, idle time.Duration, now func() time.Time) *userLimiter {
	return &userLimiter{rate: rate, burst: burst, idle: idle, now: now, users: map[string]*userBucket{}}
}

func (l *userLimiter) allow(userID string) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if !now.Before(l.nextSweep) {
		for id, user := range l.users {
			if now.Sub(user.seen) >= l.idle {
				delete(l.users, id)
			}
		}
		l.nextSweep = now.Add(l.idle)
	}
	user := l.users[userID]
	if user == nil {
		user = &userBucket{}
		l.users[userID] = user
	}
	user.seen = now
	return user.bucket.allow(now, l.rate, l.burst)
}
