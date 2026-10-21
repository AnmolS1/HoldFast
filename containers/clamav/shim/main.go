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
	ClamdConf       string
	FreshclamBoot   string // freshclam config for the boot run (no NotifyClamd: the shim reloads)
	FreshclamDaemon string // freshclam config for daemon mode (NotifyClamd)
	Socket          string
	DBDir           string
	TmpDir          string
	FreshHours      float64
	Offline         bool // never contact the signature mirror (local tests only)
	DaemonDelay     time.Duration
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
		ClamdConf:       env("CLAMD_CONF", "/etc/clamav/clamd.conf"),
		FreshclamBoot:   "/etc/clamav/freshclam-boot.conf",
		FreshclamDaemon: "/etc/clamav/freshclam.conf",
		Socket:          "/run/clamav/clamd.sock",
		DBDir:           "/var/lib/clamav",
		TmpDir:          "/scan-tmp",
		FreshHours:      hours,
		Offline:         os.Getenv("SCANNER_OFFLINE") == "1",
		DaemonDelay:     2 * time.Hour,
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
	updated     string    // daily version on disk after the boot freshclam run succeeded
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
	// (a) the first freshclam run since boot succeeded and clamd has loaded what it fetched, or
	// (b) the loaded daily database is younger than SIG_FRESH_HOURS (R2.30).
	updatedAndLoaded := g.freshclam == "ok" && g.updated != "" && g.loaded == g.updated
	young := !g.loadedBuilt.IsZero() && st.DBAgeHours < g.freshHours
	if updatedAndLoaded || young {
		st.Ready = true
	} else {
		st.NotReady = "signatures"
	}
	return st
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

	// One freshclam run per wake, then daemon mode (Checks 12) once the boot run is DaemonDelay old:
	// the daemon checks as soon as it starts, so starting it at boot would fetch twice per wake (C26).
	go func() {
		if cfg.Offline {
			log.Printf("freshclam: SCANNER_OFFLINE=1, the signature mirror is not contacted")
			g.mu.Lock()
			g.freshclam = "failed"
			g.mu.Unlock()
			return
		}
		run := exec.Command("freshclam", "--stdout", "--foreground", "--config-file="+cfg.FreshclamBoot)
		run.Stdout, run.Stderr = os.Stdout, os.Stderr
		err := run.Run()
		status, updated := "failed", ""
		if err == nil { // freshclam: 0 = up to date or updated; every other code is a failure
			status, updated = "ok", diskDaily(cfg.DBDir)
		}
		log.Printf("freshclam boot run: %s (exit %v), daily on disk %s", status, err, updated)
		g.mu.Lock()
		g.freshclam, g.updated = status, updated
		g.mu.Unlock()
		if status == "ok" {
			// The boot run does not notify clamd (it may still be loading): reload here once clamd is up.
			for {
				st := g.Status()
				if st.Clamd == "down" {
					break
				}
				if st.Clamd == "up" {
					if st.DBVersion != updated {
						ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
						reply, err := clamd.Command(ctx, "RELOAD")
						cancel()
						log.Printf("clamd RELOAD after freshclam: %q %v", reply, err)
					}
					break
				}
				time.Sleep(time.Second)
			}
		}
		time.Sleep(cfg.DaemonDelay)
		daemon := start("freshclam", "--stdout", "--foreground", "--daemon", "--checks=12", "--config-file="+cfg.FreshclamDaemon)
		go func() { _ = daemon.Wait() }()
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
