package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"path/filepath"
	"strings"
	"testing"
)

// fakeClamd accepts one INSTREAM connection, collects the chunks and reports whether the
// terminating zero-length chunk arrived.
func fakeClamd(t *testing.T, reply string) (Clamd, <-chan []byte, <-chan bool) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "clamd.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got, terminated := make(chan []byte, 1), make(chan bool, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		cmd := make([]byte, len("zINSTREAM\x00"))
		if _, err := io.ReadFull(conn, cmd); err != nil || string(cmd) != "zINSTREAM\x00" {
			got <- nil
			terminated <- false
			return
		}
		var data bytes.Buffer
		for {
			var n uint32
			if err := binary.Read(conn, binary.BigEndian, &n); err != nil {
				got <- data.Bytes()
				terminated <- false
				return
			}
			if n == 0 {
				conn.Write([]byte(reply + "\x00"))
				got <- data.Bytes()
				terminated <- true
				return
			}
			if _, err := io.CopyN(&data, conn, int64(n)); err != nil {
				got <- data.Bytes()
				terminated <- false
				return
			}
		}
	}()
	return Clamd{Socket: sock}, got, terminated
}

func TestInstreamSendsExactlyTheBodyAndHashesIt(t *testing.T) {
	c, got, terminated := fakeClamd(t, "stream: OK")
	body := bytes.Repeat([]byte("holdfast"), 300_000) // 2.4 MB: several 1 MiB chunks
	h := sha256.New()
	reply, err := c.Instream(context.Background(), bytes.NewReader(body), int64(len(body)), h)
	if err != nil || reply != "stream: OK" {
		t.Fatalf("reply %q err %v", reply, err)
	}
	if !bytes.Equal(<-got, body) || !<-terminated {
		t.Fatal("clamd did not receive exactly the body followed by the terminator")
	}
	want := sha256.Sum256(body)
	if !bytes.Equal(h.Sum(nil), want[:]) {
		t.Fatal("hash differs from the body's SHA-256")
	}
}

func TestInstreamShortBodyIsNeverScanned(t *testing.T) {
	c, _, terminated := fakeClamd(t, "stream: OK")
	_, err := c.Instream(context.Background(), strings.NewReader("only ten b"), 11, sha256.New())
	if !errors.Is(err, ErrBodyShort) {
		t.Fatalf("err = %v, want ErrBodyShort", err)
	}
	if <-terminated {
		t.Fatal("a short body was handed to clamd as complete")
	}
}

func TestInstreamOverrunIsNeverScanned(t *testing.T) {
	c, _, terminated := fakeClamd(t, "stream: OK")
	_, err := c.Instream(context.Background(), strings.NewReader("eleven byte"), 10, sha256.New())
	if !errors.Is(err, ErrBodyOverrun) {
		t.Fatalf("err = %v, want ErrBodyOverrun", err)
	}
	if <-terminated {
		t.Fatal("an overrunning body was handed to clamd as complete")
	}
}

func TestInstreamEmptyBody(t *testing.T) {
	c, got, terminated := fakeClamd(t, "stream: OK")
	reply, err := c.Instream(context.Background(), strings.NewReader(""), 0, sha256.New())
	if err != nil || reply != "stream: OK" || len(<-got) != 0 || !<-terminated {
		t.Fatalf("reply %q err %v", reply, err)
	}
}

// A reply cut off before its NUL terminator is an error, never a reply (review m6).
func TestReplyWithoutTerminatorIsAnError(t *testing.T) {
	for _, sent := range []string{"stream: OK", "PONG", ""} {
		sock := filepath.Join(t.TempDir(), "clamd.sock")
		ln, err := net.Listen("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			io.ReadFull(conn, make([]byte, len("zPING\x00")))
			conn.Write([]byte(sent))
			conn.Close()
		}()
		reply, err := Clamd{Socket: sock}.Command(context.Background(), "PING")
		ln.Close()
		if err == nil {
			t.Errorf("reply %q without NUL accepted as %q", sent, reply)
		}
	}
	// With the NUL it is a reply.
	if reply, err := readReply(strings.NewReader("stream: OK\x00")); err != nil || reply != "stream: OK" {
		t.Fatalf("%q %v", reply, err)
	}
}
