package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const (
	// ScanMaxBytes is the product cap (D4, MAX_FILE_BYTES). clamd's own limit is 2,097,152,000 bytes
	// and it only says so after reading everything, so the shim enforces the cap before reading.
	ScanMaxBytes int64 = 2_000_000_000
	// SmallScanBytes: a scan at or below this size bypasses the large-scan slot.
	SmallScanBytes int64 = 8 << 20
	// SmallScanSlots bounds concurrent small scans.
	SmallScanSlots = 4
	// ScanBudget is the outer bound of one /scan (under the queue consumer's 15-minute wall, C10).
	ScanBudget = 12 * time.Minute
	// SpoolMargin is kept free on /scan-tmp beyond a large scan's declared size.
	SpoolMargin int64 = 256 << 20

	retryNotReady = "30"
	retryBusy     = "15"
)

// Engine is what the server needs from clamd.
type Engine interface {
	Instream(ctx context.Context, body io.Reader, size int64, hash io.Writer) (string, error)
}

// Status is the state the freshness gate decides on; the monitor in main.go keeps it current.
type Status struct {
	Ready      bool
	Clamd      string // up | loading | down
	Engine     string
	DBVersion  string
	DBAgeHours float64
	Freshclam  string // pending | ok | failed
	NotReady   string // signatures | clamd_loading (when !Ready)
}

type Server struct {
	Engine  Engine
	Status  func() Status
	FreeTmp func() (int64, error) // free bytes in clamd's TemporaryDirectory
	Budget  time.Duration

	large chan struct{}
	small chan struct{}
	once  sync.Once
}

func (s *Server) init() {
	s.once.Do(func() {
		s.large = make(chan struct{}, 1)
		s.small = make(chan struct{}, SmallScanSlots)
		if s.Budget == 0 {
			s.Budget = ScanBudget
		}
	})
}

// LargeBusy reports whether the large-scan slot is taken.
func (s *Server) LargeBusy() bool {
	s.init()
	return len(s.large) > 0
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func roundHours(h float64) float64 { return math.Round(h*10) / 10 }

func (s *Server) Handler() http.Handler {
	s.init()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.health)
	mux.HandleFunc("/scan", s.scan)
	// The container library's start-up probe (`http://ping/`) and anything else: a plain 404,
	// no side effects.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	return mux
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	st := s.Status()
	writeJSON(w, http.StatusOK, map[string]any{
		"ready":      st.Ready,
		"clamd":      st.Clamd,
		"engine":     st.Engine,
		"dbVersion":  st.DBVersion,
		"dbAgeHours": roundHours(st.DBAgeHours),
		"freshclam":  st.Freshclam,
		"busy":       s.LargeBusy(),
	})
}

// scan answers POST /scan. A refusal decided before the body is read carries its outcome in
// headers too (X-Scan-Status, X-Scan-Reason, X-Scan-Db-Age-Hours): the connection is closed with the
// upload unread, and the caller may receive the status and headers but lose the body.
func (s *Server) scan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method"})
		return
	}
	size, err := strconv.ParseInt(r.Header.Get("X-Scan-Size"), 10, 64)
	if err != nil || size < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "X-Scan-Size"})
		return
	}
	// Refusals below are decided from the headers alone: no body byte has been read.
	if size > ScanMaxBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "size", "max": ScanMaxBytes})
		return
	}
	if r.ContentLength > size {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "overrun"})
		return
	}
	st := s.Status()
	if !st.Ready {
		w.Header().Set("Retry-After", retryNotReady)
		w.Header().Set("X-Scan-Status", "not_ready")
		w.Header().Set("X-Scan-Reason", st.NotReady)
		w.Header().Set("X-Scan-Db-Age-Hours", strconv.FormatFloat(roundHours(st.DBAgeHours), 'f', -1, 64))
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "not_ready", "reason": st.NotReady, "dbAgeHours": roundHours(st.DBAgeHours),
		})
		return
	}
	busy := func() {
		w.Header().Set("Retry-After", retryBusy)
		w.Header().Set("X-Scan-Status", "busy")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "busy"})
	}
	slot := s.small
	if size > SmallScanBytes {
		slot = s.large
	}
	select {
	case slot <- struct{}{}:
		defer func() { <-slot }()
	default:
		busy()
		return
	}
	if size > SmallScanBytes {
		free, err := s.FreeTmp()
		if err != nil || free < size+SpoolMargin {
			log.Printf("scan refused: spool space free=%d need=%d err=%v", free, size+SpoolMargin, err)
			busy()
			return
		}
	}

	started := time.Now()
	// The budget bounds both legs: clamd (the context) and a client that stops sending (the read
	// deadline on the request body).
	ctx, cancel := context.WithTimeout(r.Context(), s.Budget)
	defer cancel()
	_ = http.NewResponseController(w).SetReadDeadline(started.Add(s.Budget))
	hash := sha256.New()
	reply, err := s.Engine.Instream(ctx, r.Body, size, hash)
	elapsed := time.Since(started)
	v := Verdict{
		SHA256: hex.EncodeToString(hash.Sum(nil)), Bytes: size, Engine: st.Engine, DBVersion: st.DBVersion,
		DBAgeHours: roundHours(st.DBAgeHours), DurationMs: elapsed.Milliseconds(),
		Signatures: []string{}, PUA: []string{},
	}
	switch {
	case errors.Is(err, ErrBodyOverrun):
		log.Printf("scan refused: body longer than declared %d bytes", size)
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "overrun"})
		return
	case errors.Is(err, ErrBodyShort):
		log.Printf("scan refused: body shorter than declared %d bytes", size)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "short"})
		return
	case err != nil && (ctx.Err() == context.DeadlineExceeded || elapsed >= s.Budget):
		v.Status, v.Reason = "error", "timeout"
	case err != nil:
		v.Status, v.Reason = "error", "engine"
		log.Printf("scan error after %s: %v", elapsed.Round(time.Millisecond), err)
	default:
		v.Status, v.Reason, v.Signatures, v.PUA = Classify(reply)
	}
	log.Printf("scan bytes=%d ms=%d status=%s reason=%s signatures=%v pua=%v", size, v.DurationMs, v.Status, v.Reason, v.Signatures, v.PUA)
	writeJSON(w, http.StatusOK, v)
}
