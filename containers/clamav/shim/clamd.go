package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// Clamd speaks clamd's command protocol on its unix socket: z-prefixed, NUL-terminated commands and
// replies (https://docs.clamav.net/manual/Usage/Scanning.html#clamd).
type Clamd struct {
	Socket string
}

// ErrBodyOverrun: the body carried more bytes than X-Scan-Size declared.
var ErrBodyOverrun = errors.New("body longer than declared")

// ErrBodyShort: the body ended before X-Scan-Size bytes arrived.
var ErrBodyShort = errors.New("body shorter than declared")

const chunkBytes = 1 << 20

func (c Clamd) dial(ctx context.Context) (net.Conn, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", c.Socket)
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	return conn, nil
}

func readReply(r io.Reader) (string, error) {
	reply, err := bufio.NewReader(r).ReadString(0)
	if err != nil && reply == "" {
		return "", err
	}
	return strings.TrimSpace(strings.TrimRight(reply, "\x00")), nil
}

// Command sends one short command (PING, VERSION, RELOAD) and returns the reply.
func (c Clamd) Command(ctx context.Context, cmd string) (string, error) {
	conn, err := c.dial(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	// Close the connection when the context ends, so a clamd that is reloading cannot hold us.
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if _, err := conn.Write([]byte("z" + cmd + "\x00")); err != nil {
		return "", err
	}
	return readReply(conn)
}

// Instream sends exactly `size` bytes of body to clamd with INSTREAM, hashing them on the way
// (`hash` sees every byte sent), and returns clamd's reply. It never sends the terminating
// zero-length chunk unless exactly `size` bytes arrived and the body has nothing more: a short
// body returns ErrBodyShort, a longer one ErrBodyOverrun, and in both cases the connection is
// dropped so clamd scans nothing.
func (c Clamd) Instream(ctx context.Context, body io.Reader, size int64, hash io.Writer) (string, error) {
	conn, err := c.dial(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	w := bufio.NewWriterSize(conn, chunkBytes+4)
	if _, err := w.WriteString("zINSTREAM\x00"); err != nil {
		return "", err
	}
	buf := make([]byte, chunkBytes)
	var sent int64
	var header [4]byte
	for sent < size {
		want := int64(len(buf))
		if size-sent < want {
			want = size - sent
		}
		n, rerr := io.ReadFull(body, buf[:want])
		if n > 0 {
			hash.Write(buf[:n])
			binary.BigEndian.PutUint32(header[:], uint32(n))
			if _, err := w.Write(header[:]); err != nil {
				return c.earlyReply(conn, err)
			}
			if _, err := w.Write(buf[:n]); err != nil {
				return c.earlyReply(conn, err)
			}
			sent += int64(n)
		}
		if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
			return "", ErrBodyShort
		}
		if rerr != nil {
			return "", rerr
		}
	}
	// Exactly `size` bytes arrived: one more byte means the body is longer than declared.
	var one [1]byte
	if n, _ := io.ReadFull(body, one[:]); n > 0 {
		return "", ErrBodyOverrun
	}
	if _, err := w.Write([]byte{0, 0, 0, 0}); err != nil {
		return c.earlyReply(conn, err)
	}
	if err := w.Flush(); err != nil {
		return c.earlyReply(conn, err)
	}
	reply, err := readReply(conn)
	if err != nil {
		return "", fmt.Errorf("clamd reply: %w", err)
	}
	return reply, nil
}

// earlyReply: clamd stops reading and answers on its own (a size limit, an error) — return what it
// said if it said anything, else the write error.
func (c Clamd) earlyReply(conn net.Conn, werr error) (string, error) {
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if reply, err := readReply(conn); err == nil && reply != "" {
		return reply, nil
	}
	return "", werr
}

// ParseVersion splits clamd's VERSION reply, `ClamAV 1.5.4/28151/Mon Oct 12 06:24:02 2026`, into the
// engine, the daily database version and that database's build time. clamd prints the time with
// ctime() in the container's zone, which the image pins to UTC (TZ=Etc/UTC).
func ParseVersion(reply string) (engine, daily string, built time.Time, err error) {
	parts := strings.SplitN(reply, "/", 3)
	if len(parts) != 3 || !strings.HasPrefix(parts[0], "ClamAV ") {
		return "", "", time.Time{}, fmt.Errorf("unexpected VERSION reply %q", reply)
	}
	built, err = time.ParseInLocation("Mon Jan _2 15:04:05 2006", strings.TrimSpace(parts[2]), time.UTC)
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("unexpected VERSION date %q: %w", parts[2], err)
	}
	return parts[0], parts[1], built, nil
}

// ReadDBHeader reads the 512-byte header of a .cvd/.cld file:
// `ClamAV-VDB:<date>:<version>:<sigs>:<flevel>:<md5>:<dsig>:<builder>:<stime>`.
func ReadDBHeader(r io.Reader) (version string, built time.Time, err error) {
	header := make([]byte, 512)
	if _, err := io.ReadFull(r, header); err != nil {
		return "", time.Time{}, err
	}
	fields := strings.Split(string(bytes.TrimRight(header, " \x00")), ":")
	if len(fields) < 9 || fields[0] != "ClamAV-VDB" {
		return "", time.Time{}, fmt.Errorf("not a ClamAV database header")
	}
	var stime int64
	if _, err := fmt.Sscanf(strings.TrimSpace(fields[8]), "%d", &stime); err != nil {
		return "", time.Time{}, fmt.Errorf("database header build time %q: %w", fields[8], err)
	}
	return fields[2], time.Unix(stime, 0).UTC(), nil
}
