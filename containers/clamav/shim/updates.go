package main

import (
	"context"
	"os"
	"os/exec"
	"time"
)

const (
	// UpdateEvery is the interval after a successful freshclam run (the 12 checks a day of `Checks 12`).
	UpdateEvery = 2 * time.Hour
	// RetryFirst is the wait after a first failed run; it doubles per consecutive failure up to
	// UpdateEvery (review d1). freshclam's own CDN cool-down (freshclam.dat) applies on top.
	RetryFirst = 15 * time.Minute
	// FreshclamTimeout bounds one freshclam run (review d2): a stalled run is killed and counts as a
	// failure. S2 measured 12.6 s for a daily update on standard-1, 10 s for a full fetch locally.
	FreshclamTimeout = 10 * time.Minute
)

// retryDelay is the wait before the next run, given the number of consecutive failures so far.
func retryDelay(failures int) time.Duration {
	if failures <= 0 {
		return UpdateEvery
	}
	delay := RetryFirst
	for i := 1; i < failures && delay < UpdateEvery; i++ {
		delay *= 2
	}
	if delay > UpdateEvery {
		delay = UpdateEvery
	}
	return delay
}

// runUpdates runs freshclam `runs` times (0: forever), waiting retryDelay between runs.
func runUpdates(u *updater, runs int, wait func(time.Duration)) {
	failures := 0
	for i := 0; runs <= 0 || i < runs; i++ {
		if u.once() {
			failures = 0
		} else {
			failures++
		}
		wait(retryDelay(failures))
	}
}

// runLimited runs a command with its output on ours, killed after `limit`.
func runLimited(limit time.Duration, name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.WaitDelay = 10 * time.Second
	return cmd.Run()
}
