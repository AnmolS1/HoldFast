package main

import (
	"errors"
	"testing"
	"time"
)

// d1: after a failed run the next one comes 15 min later, doubling up to the 2 h interval; after a
// success, 2 h. Never more often than 15 min (freshclam's own CDN cool-down applies on top).
func TestRetryDelay(t *testing.T) {
	cases := []struct {
		failures int
		want     time.Duration
	}{
		{0, 2 * time.Hour},
		{1, 15 * time.Minute},
		{2, 30 * time.Minute},
		{3, time.Hour},
		{4, 2 * time.Hour},
		{5, 2 * time.Hour},
		{60, 2 * time.Hour}, // no overflow
	}
	for _, c := range cases {
		if got := retryDelay(c.failures); got != c.want {
			t.Errorf("retryDelay(%d) = %v, want %v", c.failures, got, c.want)
		}
	}
}

// d1: the loop counts consecutive failures from once() and resets on success.
func TestUpdateLoopBacksOff(t *testing.T) {
	now := time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
	g := &gate{freshclam: "pending", freshHours: 24, now: func() time.Time { return now }}
	results := []error{errors.New("429"), errors.New("429"), errors.New("429"), nil, errors.New("429")}
	u := &updater{
		g:         g,
		run:       func() error { r := results[0]; results = results[1:]; return r },
		diskDaily: func() string { return "1" },
		reload:    func(string) {},
	}
	var waits []time.Duration
	runUpdates(u, 5, func(d time.Duration) { waits = append(waits, d) })
	want := []time.Duration{15 * time.Minute, 30 * time.Minute, time.Hour, 2 * time.Hour, 15 * time.Minute}
	if len(waits) != len(want) {
		t.Fatalf("waits %v, want %v", waits, want)
	}
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("waits %v, want %v", waits, want)
		}
	}
}

// d2: a freshclam run that does not finish is killed at its wall-clock limit and counts as a failure.
func TestFreshclamWallClockLimit(t *testing.T) {
	started := time.Now()
	err := runLimited(200*time.Millisecond, "sleep", "30")
	if err == nil {
		t.Fatal("a run past its limit returned success")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("the limit did not stop the run: %v", elapsed)
	}
	if err := runLimited(5*time.Second, "true"); err != nil {
		t.Fatalf("a quick run failed: %v", err)
	}
	if FreshclamTimeout != 10*time.Minute {
		t.Fatalf("FreshclamTimeout %v", FreshclamTimeout)
	}
}
