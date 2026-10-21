package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	cases := []struct {
		reply, status, reason string
		signatures, pua       []string
	}{
		{"stream: OK", "clean", "", []string{}, []string{}},
		{"stream: Eicar-Test-Signature FOUND", "infected", "", []string{"Eicar-Test-Signature"}, []string{}},
		{"stream: Holdfast.Test.Marker.UNOFFICIAL FOUND", "infected", "", []string{"Holdfast.Test.Marker.UNOFFICIAL"}, []string{}},
		{"stream: Heuristics.Limits.Exceeded.MaxRecursion FOUND", "limits_exceeded", "limits", []string{"Heuristics.Limits.Exceeded.MaxRecursion"}, []string{}},
		{"stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND", "limits_exceeded", "limits", []string{"Heuristics.Limits.Exceeded.MaxFileSize"}, []string{}},
		// A cut-off by MaxScanTime is a slow scan, never a limit breach of the file (spike S2).
		{"stream: Heuristics.Limits.Exceeded.MaxScanTime FOUND", "error", "timeout", []string{}, []string{}},
		{"stream: Heuristics.Encrypted.Zip FOUND", "encrypted", "encrypted", []string{"Heuristics.Encrypted.Zip"}, []string{}},
		{"stream: Heuristics.Encrypted.PDF FOUND", "encrypted", "encrypted", []string{"Heuristics.Encrypted.PDF"}, []string{}},
		// A PUA name may be the one name clamd reports for an object whose other members it could not
		// inspect (encrypted, past a limit): never clean (review B1).
		{"stream: PUA.Win.Packer.Upx-1 FOUND", "error", "engine", []string{}, []string{}},
		{"stream: PUA.Holdfast.TestSample.UNOFFICIAL FOUND", "error", "engine", []string{}, []string{}},
		{"INSTREAM size limit exceeded. ERROR", "error", "engine", []string{}, []string{}},
		{"Error writing to temporary file ERROR", "error", "engine", []string{}, []string{}},
		{"stream:  FOUND", "error", "engine", []string{}, []string{}},
		{"", "error", "engine", []string{}, []string{}},
		{"something new", "error", "engine", []string{}, []string{}},
	}
	for _, c := range cases {
		status, reason, sigs, pua := Classify(c.reply)
		if status != c.status || reason != c.reason || !reflect.DeepEqual(sigs, c.signatures) || !reflect.DeepEqual(pua, c.pua) {
			t.Errorf("Classify(%q) = %q %q %v %v, want %q %q %v %v", c.reply, status, reason, sigs, pua, c.status, c.reason, c.signatures, c.pua)
		}
	}
}

func TestParseVersion(t *testing.T) {
	engine, daily, built, err := ParseVersion("ClamAV 1.5.4/28151/Mon Oct 12 06:24:02 2026")
	if err != nil || engine != "ClamAV 1.5.4" || daily != "28151" || !built.Equal(time.Date(2026, 10, 12, 6, 24, 2, 0, time.UTC)) {
		t.Fatalf("got %q %q %v %v", engine, daily, built, err)
	}
	// ctime pads a one-digit day with a space.
	if _, _, built, err := ParseVersion("ClamAV 1.5.4/28140/Thu Oct  1 06:24:02 2026"); err != nil || built.Day() != 1 {
		t.Fatalf("one-digit day: %v %v", built, err)
	}
	for _, bad := range []string{"", "PONG", "ClamAV 1.5.4", "ClamAV 1.5.4/28151/yesterday"} {
		if _, _, _, err := ParseVersion(bad); err == nil {
			t.Errorf("ParseVersion(%q) accepted", bad)
		}
	}
}

func TestReadDBHeader(t *testing.T) {
	h := "ClamAV-VDB:12 Oct 2026 06-24 +0000:28151:355760:90:0123456789abcdef0123456789abcdef:sig:builder:1791786242"
	header := h + strings.Repeat(" ", 512-len(h))
	version, built, err := ReadDBHeader(strings.NewReader(header + "rest of the file"))
	if err != nil || version != "28151" || built.Unix() != 1791786242 {
		t.Fatalf("got %q %v %v", version, built, err)
	}
	if _, _, err := ReadDBHeader(strings.NewReader(strings.Repeat("x", 512))); err == nil {
		t.Fatal("accepted a non-database header")
	}
	if _, _, err := ReadDBHeader(strings.NewReader("ClamAV-VDB:short")); err == nil {
		t.Fatal("accepted a short header")
	}
}

func TestGate(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	fresh, stale := now.Add(-3*time.Hour), now.Add(-30*time.Hour)
	cases := []struct {
		name     string
		g        *gate
		ready    bool
		clamd    string
		notReady string
	}{
		{"loading", &gate{freshclam: "pending"}, false, "loading", "clamd_loading"},
		{"down", &gate{clamdExited: true, freshclam: "ok"}, false, "down", "clamd_loading"},
		{"fresh bake, no update", &gate{clamdUp: true, loaded: "1", loadedBuilt: fresh, freshclam: "failed"}, true, "up", ""},
		{"fresh bake, update pending", &gate{clamdUp: true, loaded: "1", loadedBuilt: fresh, freshclam: "pending"}, true, "up", ""},
		{"stale, update pending", &gate{clamdUp: true, loaded: "1", loadedBuilt: stale, freshclam: "pending"}, false, "up", "signatures"},
		{"stale, update failed", &gate{clamdUp: true, loaded: "1", loadedBuilt: stale, freshclam: "failed"}, false, "up", "signatures"},
		{"stale, updated, not reloaded", &gate{clamdUp: true, loaded: "1", loadedBuilt: stale, freshclam: "ok", updated: "2"}, false, "up", "signatures"},
		{"stale, updated and reloaded", &gate{clamdUp: true, loaded: "2", loadedBuilt: stale, freshclam: "ok", updated: "2", updatedAt: now.Add(-time.Hour)}, true, "up", ""},
		{"stale, up to date (no new version)", &gate{clamdUp: true, loaded: "1", loadedBuilt: stale, freshclam: "ok", updated: "1", updatedAt: now.Add(-time.Hour)}, true, "up", ""},
		// The ruling on M1: an update keeps the gate open only SIG_FRESH_HOURS after it succeeded.
		{"stale, last update 25 h ago", &gate{clamdUp: true, loaded: "1", loadedBuilt: stale, freshclam: "failed", updated: "1", updatedAt: now.Add(-25 * time.Hour)}, false, "up", "signatures"},
		{"stale, last update exactly 24 h ago", &gate{clamdUp: true, loaded: "1", loadedBuilt: stale, freshclam: "ok", updated: "1", updatedAt: now.Add(-24 * time.Hour)}, false, "up", "signatures"},
		{"exactly at the threshold", &gate{clamdUp: true, loaded: "1", loadedBuilt: now.Add(-24 * time.Hour), freshclam: "failed"}, false, "up", "signatures"},
	}
	for _, c := range cases {
		g := c.g
		g.freshHours, g.now = 24, func() time.Time { return now }
		st := g.Status()
		if st.Ready != c.ready || st.Clamd != c.clamd || st.NotReady != c.notReady {
			t.Errorf("%s: ready=%v clamd=%q notReady=%q", c.name, st.Ready, st.Clamd, st.NotReady)
		}
	}
	// SIG_FRESH_HOURS=0: no database is young enough, only a successful update opens the gate.
	g := gate{clamdUp: true, loaded: "1", loadedBuilt: now, freshclam: "pending", freshHours: 0, now: func() time.Time { return now }}
	if g.Status().Ready {
		t.Error("SIG_FRESH_HOURS=0 let a database through without an update")
	}
}

// A long-lived instance whose updates keep failing after one success goes not_ready once that
// success is SIG_FRESH_HOURS old (review M1), and a later success opens the gate again.
func TestUpdatesExpire(t *testing.T) {
	now := time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
	g := &gate{clamdUp: true, loaded: "100", loadedBuilt: now.Add(-30 * time.Hour), freshclam: "pending", freshHours: 24,
		now: func() time.Time { return now }}
	results := []error{nil}
	reloads := 0
	u := &updater{
		g:         g,
		run:       func() error { r := results[0]; results = results[1:]; return r },
		diskDaily: func() string { return "100" },
		reload:    func(string) { reloads++ },
	}
	if g.Status().Ready {
		t.Fatal("a 30 h old bake was ready before any update")
	}
	u.once()
	if !g.Status().Ready || g.Status().Freshclam != "ok" {
		t.Fatalf("not ready after a successful update: %+v", g.Status())
	}
	for h := 2; h < 24; h += 2 {
		now = now.Add(2 * time.Hour)
		results = append(results, errors.New("rate limited"))
		u.once()
		if st := g.Status(); !st.Ready || st.Freshclam != "failed" {
			t.Fatalf("%d h after the update: %+v", h, st)
		}
	}
	now = now.Add(2 * time.Hour) // 24 h after the last success
	results = append(results, errors.New("rate limited"))
	u.once()
	if st := g.Status(); st.Ready || st.NotReady != "signatures" {
		t.Fatalf("24 h after the last success, updates failing: %+v", st)
	}
	results = append(results, nil)
	u.once()
	if !g.Status().Ready {
		t.Fatal("a new successful update did not open the gate")
	}
	if reloads != 2 {
		t.Fatalf("reload called %d times, want once per successful update", reloads)
	}
}
