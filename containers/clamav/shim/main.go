// The Holdfast scanner shim: an HTTP front for clamd on :8080 (T20). It starts clamd and freshclam
// as its children, keeps the freshness gate, and streams /scan bodies to clamd with INSTREAM.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

type config struct {
	ClamdConf     string
	FreshclamConf string // no NotifyClamd: the shim reloads clamd itself
	Socket        string
	DBDir         string
	TmpDir        string
	FreshHours    float64
	Offline       bool // never contact the signature mirror (local tests only)
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func loadConfig() config {
	hours, err := strconv.ParseFloat(env("SIG_FRESH_HOURS", "24"), 64)
	if err != nil || hours < 0 {
		log.Fatalf("SIG_FRESH_HOURS must be a number of hours")
	}
	return config{
		ClamdConf:     env("CLAMD_CONF", "/etc/clamav/clamd.conf"),
		FreshclamConf: "/etc/clamav/freshclam.conf",
		Socket:        "/scanner-run/clamd.sock", // clamd.conf LocalSocket: not under /run (a fresh mount at boot)
		DBDir:         "/var/lib/clamav",
		TmpDir:        "/scan-tmp",
		FreshHours:    hours,
		Offline:       os.Getenv("SCANNER_OFFLINE") == "1",
	}
}

// gate holds what the freshness gate decides on.
type gate struct {
	mu          sync.Mutex
	clamdExited bool
	clamdUp     bool
	engine      string
	loaded      string    // daily version clamd has loaded (VERSION)
	loadedBuilt time.Time // its build time
	freshclam   string    // pending | ok | failed
	updated     string    // daily version on disk after the last successful freshclam run
	updatedAt   time.Time // when that run succeeded
	freshHours  float64
	now         func() time.Time
}

func (g *gate) Status() Status {
	g.mu.Lock()
	defer g.mu.Unlock()
	st := Status{Engine: g.engine, DBVersion: g.loaded, Freshclam: g.freshclam}
	if !g.loadedBuilt.IsZero() {
		st.DBAgeHours = g.now().Sub(g.loadedBuilt).Hours()
	}
	switch {
	case g.clamdExited:
		st.Clamd = "down"
	case g.clamdUp:
		st.Clamd = "up"
	default:
		st.Clamd = "loading"
	}
	if !g.clamdUp || g.loaded == "" {
		st.NotReady = "clamd_loading"
		return st
	}
	// (a) a freshclam run succeeded less than SIG_FRESH_HOURS ago and clamd has loaded what it
	// fetched (an update keeps the gate open only that long — ruling on review M1), or
	// (b) the loaded daily database is younger than SIG_FRESH_HOURS (R2.30).
	updatedAndLoaded := !g.updatedAt.IsZero() && g.now().Sub(g.updatedAt).Hours() < g.freshHours &&
		g.updated != "" && g.loaded == g.updated
	young := !g.loadedBuilt.IsZero() && st.DBAgeHours < g.freshHours
	if updatedAndLoaded || young {
		st.Ready = true
	} else {
		st.NotReady = "signatures"
	}
	return st
}

// updater runs freshclam once and records the outcome in the gate; after a success it has clamd
// load what was fetched. main runs it at boot, then every UpdateEvery (sooner after a failure).
type updater struct {
	g         *gate
	run       func() error         // one freshclam run; nil = exit 0 (up to date or updated)
	diskDaily func() string        // the daily version on disk
	reload    func(version string) // make clamd load `version` (waits for clamd; RELOAD if needed)
}

// once runs freshclam and reports whether it succeeded.
func (u *updater) once() bool {
	if err := u.run(); err != nil {
		log.Printf("freshclam: failed (%v)", err)
		u.g.mu.Lock()
		u.g.freshclam = "failed"
		u.g.mu.Unlock()
		return false
	}
	version := u.diskDaily()
	log.Printf("freshclam: ok, daily on disk %s", version)
	u.g.mu.Lock()
	u.g.freshclam, u.g.updated, u.g.updatedAt = "ok", version, u.g.now()
	u.g.mu.Unlock()
	u.reload(version)
	return true
}

// diskDaily is the version of the newest daily database on disk (daily.cld after an update,
// daily.cvd as baked).
func diskDaily(dir string) string {
	best := ""
	for _, name := range []string{"daily.cvd", "daily.cld"} {
		f, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		v, _, err := ReadDBHeader(f)
		f.Close()
		if err != nil {
			continue
		}
		if a, _ := strconv.Atoi(v); best == "" || a > atoi(best) {
			best = v
		}
	}
	return best
}

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

func start(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		log.Fatalf("start %s: %v", name, err)
	}
	return cmd
}

func main() {
	log.SetFlags(log.LUTC | log.Ldate | log.Ltime)
	cfg := loadConfig()
	g := &gate{freshclam: "pending", freshHours: cfg.FreshHours, now: time.Now}
	clamd := Clamd{Socket: cfg.Socket}

	srv := &Server{
		Engine: clamd,
		Status: g.Status,
		FreeTmp: func() (int64, error) {
			var fs syscall.Statfs_t
			if err := syscall.Statfs(cfg.TmpDir, &fs); err != nil {
				return 0, err
			}
			return int64(fs.Bavail) * int64(fs.Bsize), nil
		},
		Sweep: func() { sweepDir(cfg.TmpDir) },
	}
	// Listen first: the container library probes the port for ~20 s, and clamd needs longer to load.
	httpServer := &http.Server{Addr: ":8080", Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	clamdCmd := start("clamd", "--foreground", "--config-file="+cfg.ClamdConf)
	exited := make(chan error, 1)
	go func() { exited <- clamdCmd.Wait() }()

	// Monitor: PING + VERSION every 2 s, so the gate and /health never wait on clamd.
	go func() {
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			pong, err := clamd.Command(ctx, "PING")
			up := err == nil && pong == "PONG"
			var engine, daily string
			var built time.Time
			if up {
				if reply, err := clamd.Command(ctx, "VERSION"); err == nil {
					if e, d, b, err := ParseVersion(reply); err == nil {
						engine, daily, built = e, d, b
					}
				}
			}
			cancel()
			g.mu.Lock()
			g.clamdUp = up && daily != ""
			if daily != "" {
				g.engine, g.loaded, g.loadedBuilt = engine, daily, built
			}
			g.mu.Unlock()
			time.Sleep(2 * time.Second)
		}
	}()

	// freshclam at boot, then every UpdateEvery (the 12 checks a day of `Checks 12`) — after a failure
	// at 15 min doubling up to that (review d1), each run limited to FreshclamTimeout — run by the
	// shim rather than `freshclam -d` so that every success is recorded: the gate's path (a) lasts
	// SIG_FRESH_HOURS from the last success. One run per wake; nothing runs on a schedule while the
	// container sleeps.
	go func() {
		if cfg.Offline {
			log.Printf("freshclam: SCANNER_OFFLINE=1, the signature mirror is not contacted")
			g.mu.Lock()
			g.freshclam = "failed"
			g.mu.Unlock()
			return
		}
		u := &updater{
			g: g,
			run: func() error {
				// exit 0 = up to date or updated; every other code, and a run past the limit, is a failure
				return runLimited(FreshclamTimeout, "freshclam", "--stdout", "--foreground", "--config-file="+cfg.FreshclamConf)
			},
			diskDaily: func() string { return diskDaily(cfg.DBDir) },
			reload: func(version string) {
				// Wait for clamd, then RELOAD if it has not loaded `version`.
				for {
					st := g.Status()
					if st.Clamd == "down" {
						return
					}
					if st.Clamd == "up" {
						if st.DBVersion != version {
							ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
							reply, err := clamd.Command(ctx, "RELOAD")
							cancel()
							log.Printf("clamd RELOAD after freshclam: %q %v", reply, err)
						}
						return
					}
					time.Sleep(time.Second)
				}
			},
		}
		runUpdates(u, 0, time.Sleep)
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	select {
	case s := <-sig:
		log.Printf("shim: %v, stopping", s)
		_ = clamdCmd.Process.Signal(syscall.SIGTERM)
	case err := <-exited:
		// clamd is gone: answer not_ready briefly, then exit so the platform starts a fresh instance.
		log.Printf("clamd exited: %v", err)
		g.mu.Lock()
		g.clamdExited, g.clamdUp = true, false
		g.mu.Unlock()
		time.Sleep(5 * time.Second)
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
}
