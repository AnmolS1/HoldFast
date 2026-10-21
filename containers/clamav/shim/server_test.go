package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeEngine reads the whole body (as clamd would) unless told to block, then answers `reply`.
type fakeEngine struct {
	reply   string
	calls   atomic.Int32
	entered chan struct{} // receives once per call, after the call has started
	release chan struct{} // when set, the call waits for it (or its context)
}

func (f *fakeEngine) Instream(ctx context.Context, body io.Reader, size int64, hash io.Writer) (string, error) {
	f.calls.Add(1)
	if f.entered != nil {
		f.entered <- struct{}{}
	}
	if f.release != nil {
		select {
		case <-f.release:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	n, err := io.Copy(hash, io.LimitReader(body, size))
	if err != nil {
		return "", err
	}
	if n < size {
		return "", ErrBodyShort
	}
	return f.reply, nil
}

// countingBody records whether anything read from it.
type countingBody struct {
	r    io.Reader
	read atomic.Int64
}

func (c *countingBody) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.read.Add(int64(n))
	return n, err
}

func readyStatus() Status {
	return Status{Ready: true, Clamd: "up", Engine: "ClamAV 1.5.4", DBVersion: "28151", DBAgeHours: 3.04, Freshclam: "ok"}
}

func newServer(e Engine) *Server {
	return &Server{Engine: e, Status: readyStatus, FreeTmp: func() (int64, error) { return 7 << 30, nil }}
}

func post(t *testing.T, h http.Handler, size string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/scan", body)
	req.ContentLength = -1 // as a streamed body: the shim must not rely on Content-Length
	if size != "" {
		req.Header.Set("X-Scan-Size", size)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("body %q: %v", rec.Body.String(), err)
	}
	return m
}

func TestScanCleanCarriesHashAndBytes(t *testing.T) {
	body := bytes.Repeat([]byte{7}, 1000)
	rec := post(t, newServer(&fakeEngine{reply: "stream: OK"}).Handler(), "1000", bytes.NewReader(body))
	m := decode(t, rec)
	sum := sha256.Sum256(body)
	if rec.Code != 200 || m["status"] != "clean" || m["sha256"] != hex.EncodeToString(sum[:]) || m["bytes"] != 1000.0 ||
		m["engine"] != "ClamAV 1.5.4" || m["dbVersion"] != "28151" || m["dbAgeHours"] != 3.0 {
		t.Fatalf("%d %v", rec.Code, m)
	}
	if _, ok := m["reason"]; ok {
		t.Fatalf("a clean verdict carries a reason: %v", m)
	}
}

func TestScanVerdicts(t *testing.T) {
	for reply, want := range map[string][2]string{
		"stream: Eicar-Test-Signature FOUND":                    {"infected", ""},
		"stream: Heuristics.Limits.Exceeded.MaxScanTime FOUND":  {"error", "timeout"},
		"stream: Heuristics.Limits.Exceeded.MaxRecursion FOUND": {"limits_exceeded", "limits"},
		"stream: Heuristics.Encrypted.Zip FOUND":                {"encrypted", "encrypted"},
		"Error writing to temporary file ERROR":                 {"error", "engine"},
	} {
		m := decode(t, post(t, newServer(&fakeEngine{reply: reply}).Handler(), "3", strings.NewReader("abc")))
		if m["status"] != want[0] || (want[1] != "" && m["reason"] != want[1]) {
			t.Errorf("%q → %v", reply, m)
		}
	}
}

func TestScanSizeHeader(t *testing.T) {
	for _, size := range []string{"", "-1", "abc", "1e9", "99999999999999999999"} {
		e := &fakeEngine{reply: "stream: OK"}
		if rec := post(t, newServer(e).Handler(), size, strings.NewReader("abc")); rec.Code != 400 || e.calls.Load() != 0 {
			t.Errorf("X-Scan-Size %q → %d, %d engine calls", size, rec.Code, e.calls.Load())
		}
	}
}

func TestScanRefusesAboveTheCapBeforeReading(t *testing.T) {
	e := &fakeEngine{reply: "stream: OK"}
	body := &countingBody{r: strings.NewReader(strings.Repeat("x", 4096))}
	rec := post(t, newServer(e).Handler(), strconv.FormatInt(ScanMaxBytes+1, 10), body)
	if rec.Code != 413 || body.read.Load() != 0 || e.calls.Load() != 0 {
		t.Fatalf("code %d, read %d bytes, %d engine calls", rec.Code, body.read.Load(), e.calls.Load())
	}
	// At the cap it is accepted (the fake engine then finds the body short: 400, but not 413).
	rec = post(t, newServer(e).Handler(), strconv.FormatInt(ScanMaxBytes, 10), strings.NewReader("x"))
	if rec.Code == 413 {
		t.Fatal("a body declared exactly at the cap was refused")
	}
}

func TestScanRefusesADeclaredOverrunBeforeReading(t *testing.T) {
	e := &fakeEngine{reply: "stream: OK"}
	req := httptest.NewRequest(http.MethodPost, "/scan", strings.NewReader("abcd"))
	req.Header.Set("X-Scan-Size", "3") // Content-Length 4
	rec := httptest.NewRecorder()
	newServer(e).Handler().ServeHTTP(rec, req)
	if rec.Code != 413 || e.calls.Load() != 0 {
		t.Fatalf("code %d, %d engine calls", rec.Code, e.calls.Load())
	}
}

func TestScanOverrunAndShortBodies(t *testing.T) {
	// The real engine (Clamd.Instream) reports these; the server must answer them as refusals.
	for err, code := range map[error]int{ErrBodyOverrun: 413, ErrBodyShort: 400} {
		rec := post(t, newServer(errEngine{err}).Handler(), "3", strings.NewReader("abc"))
		if rec.Code != code || strings.Contains(rec.Body.String(), "clean") {
			t.Errorf("%v → %d %s", err, rec.Code, rec.Body.String())
		}
	}
}

type errEngine struct{ err error }

func (e errEngine) Instream(context.Context, io.Reader, int64, io.Writer) (string, error) {
	return "", e.err
}

func TestScanNotReadyGivesNoVerdict(t *testing.T) {
	for _, st := range []Status{
		{Clamd: "loading", NotReady: "clamd_loading"},
		{Clamd: "up", NotReady: "signatures", DBAgeHours: 30.04},
	} {
		e := &fakeEngine{reply: "stream: OK"}
		s := newServer(e)
		s.Status = func() Status { return st }
		body := &countingBody{r: strings.NewReader("abc")}
		rec := post(t, s.Handler(), "3", body)
		m := decode(t, rec)
		if rec.Header().Get("X-Scan-Status") != "not_ready" || rec.Header().Get("X-Scan-Reason") != st.NotReady ||
			rec.Header().Get("X-Scan-Db-Age-Hours") != strconv.FormatFloat(roundHours(st.DBAgeHours), 'f', -1, 64) {
			t.Fatalf("not_ready headers: %v", rec.Header())
		}
		if rec.Code != 503 || rec.Header().Get("Retry-After") != "30" || m["status"] != "not_ready" || m["reason"] != st.NotReady ||
			m["dbAgeHours"] != roundHours(st.DBAgeHours) || e.calls.Load() != 0 || body.read.Load() != 0 {
			t.Fatalf("%d %v %v, read %d, calls %d", rec.Code, rec.Header(), m, body.read.Load(), e.calls.Load())
		}
	}
}

func TestOneLargeScanAtATimeWhileSmallScansProceed(t *testing.T) {
	e := &fakeEngine{reply: "stream: OK", entered: make(chan struct{}, 8), release: make(chan struct{})}
	s := newServer(e)
	h := s.Handler()
	large := strconv.FormatInt(SmallScanBytes+1, 10)

	first := make(chan *httptest.ResponseRecorder)
	go func() { first <- post(t, h, large, bytes.NewReader(make([]byte, SmallScanBytes+1))) }()
	<-e.entered // the first large scan holds the slot
	if !s.LargeBusy() {
		t.Fatal("/health busy does not reflect the taken slot")
	}

	second := &countingBody{r: bytes.NewReader(make([]byte, SmallScanBytes+1))}
	rec := post(t, h, large, second)
	if rec.Code != 503 || rec.Header().Get("Retry-After") != "15" || rec.Header().Get("X-Scan-Status") != "busy" ||
		decode(t, rec)["status"] != "busy" || second.read.Load() != 0 {
		t.Fatalf("second large scan: %d %v read %d", rec.Code, rec.Header(), second.read.Load())
	}

	// A small scan is not behind the large slot.
	smallDone := make(chan *httptest.ResponseRecorder)
	go func() { smallDone <- post(t, h, "3", strings.NewReader("abc")) }()
	<-e.entered // the small scan is in the engine while the large one still holds the slot
	close(e.release)
	if rec := <-smallDone; rec.Code != 200 {
		t.Fatalf("small scan during a large one: %d", rec.Code)
	}
	if rec := <-first; rec.Code != 200 || decode(t, rec)["status"] != "clean" {
		t.Fatalf("first large scan: %d", rec.Code)
	}
	if s.LargeBusy() {
		t.Fatal("the slot was not released")
	}
	// Free again: a new large scan is accepted.
	e2 := &fakeEngine{reply: "stream: OK"}
	s.Engine = e2
	if rec := post(t, h, large, bytes.NewReader(make([]byte, SmallScanBytes+1))); rec.Code != 200 {
		t.Fatalf("large scan after release: %d", rec.Code)
	}
}

func TestSmallScansAreBoundedAtFour(t *testing.T) {
	e := &fakeEngine{reply: "stream: OK", entered: make(chan struct{}, 8), release: make(chan struct{})}
	h := newServer(e).Handler()
	done := make(chan *httptest.ResponseRecorder, SmallScanSlots)
	for i := 0; i < SmallScanSlots; i++ {
		go func() { done <- post(t, h, "3", strings.NewReader("abc")) }()
		<-e.entered
	}
	fifth := &countingBody{r: strings.NewReader("abc")}
	if rec := post(t, h, "3", fifth); rec.Code != 503 || rec.Header().Get("Retry-After") != "15" ||
		rec.Header().Get("X-Scan-Status") != "busy" || fifth.read.Load() != 0 {
		t.Fatalf("fifth small scan: %d read %d", rec.Code, fifth.read.Load())
	}
	// At the boundary: exactly SmallScanBytes is small.
	close(e.release)
	for i := 0; i < SmallScanSlots; i++ {
		if rec := <-done; rec.Code != 200 {
			t.Fatalf("small scan %d: %d", i, rec.Code)
		}
	}
	if e.calls.Load() != SmallScanSlots {
		t.Fatalf("%d engine calls", e.calls.Load())
	}
}

func TestSmallBoundaryUsesTheSmallSlots(t *testing.T) {
	e := &fakeEngine{reply: "stream: OK", entered: make(chan struct{}, 8), release: make(chan struct{})}
	s := newServer(e)
	h := s.Handler()
	done := make(chan *httptest.ResponseRecorder)
	go func() {
		done <- post(t, h, strconv.FormatInt(SmallScanBytes, 10), bytes.NewReader(make([]byte, SmallScanBytes)))
	}()
	<-e.entered
	if s.LargeBusy() {
		t.Fatal("an 8 MiB scan took the large slot")
	}
	close(e.release)
	<-done
}

func TestLargeScanRefusedWithoutSpoolSpace(t *testing.T) {
	size := SmallScanBytes + 1
	for _, free := range []func() (int64, error){
		func() (int64, error) { return size + ExtractAllowance + SpoolMargin - 1, nil },
		func() (int64, error) { return 0, errors.New("statfs failed") },
	} {
		e := &fakeEngine{reply: "stream: OK"}
		s := newServer(e)
		s.FreeTmp = free
		body := &countingBody{r: bytes.NewReader(make([]byte, size))}
		rec := post(t, s.Handler(), strconv.FormatInt(size, 10), body)
		if rec.Code != 503 || rec.Header().Get("Retry-After") != "15" || rec.Header().Get("X-Scan-Status") != "busy" ||
			decode(t, rec)["status"] != "busy" || e.calls.Load() != 0 || body.read.Load() != 0 {
			t.Fatalf("%d %s calls %d read %d", rec.Code, rec.Body.String(), e.calls.Load(), body.read.Load())
		}
		if s.LargeBusy() {
			t.Fatal("a refused scan kept the slot")
		}
	}
	// Exactly enough space: accepted.
	s := newServer(&fakeEngine{reply: "stream: OK"})
	s.FreeTmp = func() (int64, error) { return size + ExtractAllowance + SpoolMargin, nil }
	if rec := post(t, s.Handler(), strconv.FormatInt(size, 10), bytes.NewReader(make([]byte, size))); rec.Code != 200 {
		t.Fatalf("enough space: %d", rec.Code)
	}
}

func TestBudgetExceededIsATimeout(t *testing.T) {
	e := &fakeEngine{reply: "stream: OK", release: make(chan struct{})} // never released: waits for the budget
	s := newServer(e)
	s.Budget = 50 * time.Millisecond
	m := decode(t, post(t, s.Handler(), "3", strings.NewReader("abc")))
	if m["status"] != "error" || m["reason"] != "timeout" {
		t.Fatalf("%v", m)
	}
}

func TestHealth(t *testing.T) {
	s := newServer(&fakeEngine{})
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	m := decode(t, rec)
	if rec.Code != 200 || m["ready"] != true || m["clamd"] != "up" || m["engine"] != "ClamAV 1.5.4" || m["dbVersion"] != "28151" ||
		m["dbAgeHours"] != 3.0 || m["freshclam"] != "ok" || m["busy"] != false {
		t.Fatalf("%v", m)
	}
	s.Status = func() Status { return Status{Clamd: "loading", Freshclam: "pending"} }
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != 200 || decode(t, rec)["ready"] != false {
		t.Fatalf("health while loading: %d", rec.Code)
	}
}

func TestScanIsPostOnly(t *testing.T) {
	rec := httptest.NewRecorder()
	newServer(&fakeEngine{}).Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/scan", nil))
	if rec.Code != 405 {
		t.Fatalf("GET /scan: %d", rec.Code)
	}
}

// clamd extracts archive members into /scan-tmp too (measured: a 1.8 MB zip of zeros used 1.86 GB
// there), so every scan — small ones included — needs room for one extracted member of up to
// MaxFileSize beyond its own spool (review m8).
func TestSmallScanRefusedWithoutExtractionSpace(t *testing.T) {
	need := int64(3) + ExtractAllowance + SpoolMargin
	e := &fakeEngine{reply: "stream: OK"}
	s := newServer(e)
	s.FreeTmp = func() (int64, error) { return need - 1, nil }
	body := &countingBody{r: strings.NewReader("abc")}
	if rec := post(t, s.Handler(), "3", body); rec.Code != 503 || rec.Header().Get("X-Scan-Status") != "busy" || e.calls.Load() != 0 || body.read.Load() != 0 {
		t.Fatalf("small scan without extraction space: %d calls %d read %d", rec.Code, e.calls.Load(), body.read.Load())
	}
	s.FreeTmp = func() (int64, error) { return need, nil }
	if rec := post(t, s.Handler(), "3", strings.NewReader("abc")); rec.Code != 200 {
		t.Fatalf("small scan with exactly enough space: %d", rec.Code)
	}
	if ExtractAllowance != 2_097_152_000 {
		t.Fatalf("ExtractAllowance %d is not clamd.conf's MaxFileSize 2000M", ExtractAllowance)
	}
}
