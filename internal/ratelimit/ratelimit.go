// Package ratelimit is an in-memory token bucket per key (an identity or an IP address).
package ratelimit

import (
	"sync"
	"time"
)

// Limiter allows PerMinute events per key with bursts up to PerMinute.
type Limiter struct {
	perMinute float64
	now       func() time.Time

	mu      sync.Mutex
	buckets map[string]*bucket
	sweep   time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

// New returns a limiter; perMinute <= 0 disables limiting.
func New(perMinute int, now func() time.Time) *Limiter {
	return &Limiter{perMinute: float64(perMinute), now: now, buckets: map[string]*bucket{}}
}

// Allow takes one token for key and reports whether there was one.
func (l *Limiter) Allow(key string) bool {
	if l == nil || l.perMinute <= 0 {
		return true
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.sweep) > 10*time.Minute {
		for k, b := range l.buckets {
			if now.Sub(b.last) > 10*time.Minute {
				delete(l.buckets, k)
			}
		}
		l.sweep = now
	}
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.perMinute, last: now}
		l.buckets[key] = b
	}
	b.tokens = min(l.perMinute, b.tokens+now.Sub(b.last).Minutes()*l.perMinute)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
