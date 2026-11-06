package ratelimit

import (
	"testing"
	"time"
)

func TestLimiter(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l := New(3, func() time.Time { return now })
	for i := range 3 {
		if !l.Allow("a") {
			t.Fatalf("event %d refused", i)
		}
	}
	if l.Allow("a") {
		t.Fatal("burst over the limit allowed")
	}
	if !l.Allow("b") {
		t.Fatal("keys share a bucket")
	}
	now = now.Add(20 * time.Second)
	if !l.Allow("a") || l.Allow("a") {
		t.Fatal("refill is not proportional to time")
	}
	if !New(0, time.Now).Allow("x") || !(*Limiter)(nil).Allow("x") {
		t.Fatal("disabled limiter refused")
	}
}
