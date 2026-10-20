package app

import (
	"sync"
	"time"
)

type ExportLimitError struct{ RetryAfter time.Duration }

func (*ExportLimitError) Error() string { return "library export limit reached" }

type exportUser struct {
	bucket tokenBucket
	active bool
	seen   time.Time
}
type exportLimiter struct {
	mu        sync.Mutex
	users     map[string]*exportUser
	now       func() time.Time
	nextSweep time.Time
}

func newExportLimiter(now func() time.Time) *exportLimiter {
	return &exportLimiter{users: make(map[string]*exportUser), now: now}
}
func (l *exportLimiter) acquire(owner string) (func(), time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if !now.Before(l.nextSweep) {
		for id, u := range l.users {
			if !u.active && now.Sub(u.seen) >= 10*time.Minute {
				delete(l.users, id)
			}
		}
		l.nextSweep = now.Add(10 * time.Minute)
	}
	u := l.users[owner]
	if u == nil {
		u = &exportUser{}
		l.users[owner] = u
	}
	u.seen = now
	u.bucket.refill(now, 1.0/300, 1)
	if u.active {
		return nil, time.Second
	}
	if !u.bucket.allow(now, 1.0/300, 1) {
		return nil, time.Duration((1-u.bucket.tokens)*float64(5*time.Minute)) + time.Millisecond
	}
	u.active = true
	var once sync.Once
	return func() { once.Do(func() { l.mu.Lock(); defer l.mu.Unlock(); u.active = false; u.seen = l.now() }) }, 0
}
