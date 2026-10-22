package hysteria

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A-120, live against the pinned hysteria (HYSTERIA_BIN): a client holds a
// stream open, the user is removed, and the stream dies. The instrument
// first: forgetting the password alone leaves the open stream alive, which is
// the defect, and shows the test can tell a cut stream from a living one.
func TestARemovedUsersOpenStreamIsCut(t *testing.T) {
	if hysteriaBin == "" {
		t.Skip("HYSTERIA_BIN not set: the kick is not asked of the real core here")
	}
	dir := t.TempDir()
	a := New(Config{
		ConfigPath:         filepath.Join(dir, "config.yaml"),
		AuthCallbackPort:   freeTCP(t),
		TrafficStatsListen: fmt.Sprintf("127.0.0.1:%d", freeTCP(t)),
		TrafficStatsSecret: "fixture-stats-secret-not-a-secret",
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	// No BinaryPath: the agent holds the callback, the test runs hysteria.
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	_ = a.AddUser(core.User{UserID: "u-alice", HysteriaPassword: "pw-alice-not-a-secret"})
	_ = a.AddUser(core.User{UserID: "u-bob", HysteriaPassword: "pw-bob-not-a-secret"})

	certPEM, keyPEM, _ := pemPair(t)
	if err := writeTLSPair(a.cfg.ConfigPath, certPEM, keyPEM); err != nil {
		t.Fatal(err)
	}
	udp := freeUDP(t)
	blob, err := renderConfig(a.cfg, InboundConfig{Port: udp, TLSCertPEM: certPEM, TLSKeyPEM: keyPEM}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(a.cfg.ConfigPath, blob, 0o600); err != nil {
		t.Fatal(err)
	}
	run(t, dir, "server", "server up and running", hysteriaBin, "server", "-c", a.cfg.ConfigPath)

	echo := echoServer(t)
	client := func(password string) int {
		socks := freeTCP(t)
		cfg := filepath.Join(t.TempDir(), "client.yaml")
		body := fmt.Sprintf("server: 127.0.0.1:%d\nauth: %s\ntls:\n  insecure: true\nsocks5:\n  listen: 127.0.0.1:%d\n", udp, password, socks)
		if err := os.WriteFile(cfg, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		run(t, filepath.Dir(cfg), "client", "", hysteriaBin, "client", "-c", cfg)
		return socks
	}
	open := func(socks int) net.Conn {
		t.Helper()
		var lastErr error
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
			c, err := socksDial(socks, echo)
			if err == nil {
				if err = roundTrip(c); err == nil {
					return c
				}
				c.Close()
			}
			lastErr = err
		}
		t.Fatalf("no stream through socks %d: %v", socks, lastErr)
		return nil
	}
	// alive: the stream still carries bytes for the whole window.
	alive := func(c net.Conn, window time.Duration) bool {
		for end := time.Now().Add(window); time.Now().Before(end); time.Sleep(250 * time.Millisecond) {
			if roundTrip(c) != nil {
				return false
			}
		}
		return true
	}

	// The instrument: bob's password forgotten without a kick, his open
	// stream goes on.
	bob := open(client("pw-bob-not-a-secret"))
	defer bob.Close()
	a.mu.Lock()
	delete(a.users, "pw-bob-not-a-secret")
	a.mu.Unlock()
	if !alive(bob, 3*time.Second) {
		t.Fatal("bob's stream died without a kick, so this test cannot tell a kick from nothing")
	}

	aliceSocks := client("pw-alice-not-a-secret")
	alice := open(aliceSocks)
	defer alice.Close()
	if err := a.RemoveUser("u-alice"); err != nil {
		t.Fatalf("RemoveUser: %v", err)
	}
	if alive(alice, 5*time.Second) {
		t.Fatal("alice's open stream outlived her removal")
	}
	// And the client's reconnect is refused: the password went first.
	if c, err := socksDial(aliceSocks, echo); err == nil {
		err = roundTrip(c)
		c.Close()
		if err == nil {
			t.Fatal("alice got a new stream after her removal")
		}
	}
	if !alive(bob, time.Second) {
		t.Error("kicking alice cut bob")
	}
}

// run starts a process from dir and, when ready is set, waits for it in the
// output.
func run(t *testing.T, dir, name, ready string, bin string, args ...string) {
	t.Helper()
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	var out lockedBuffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s: %v", name, err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	if ready == "" {
		return
	}
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		s := out.String()
		if strings.Contains(s, ready) {
			return
		}
		if strings.Contains(s, "FATAL") {
			t.Fatalf("%s: %s", name, s)
		}
	}
	t.Fatalf("%s not up: %s", name, out.String())
}

func echoServer(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(c, c); _ = c.Close() }()
		}
	}()
	return l.Addr().String()
}

// socksDial opens a CONNECT through a socks5 proxy without auth.
func socksDial(socks int, target string) (net.Conn, error) {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", socks), 2*time.Second)
	if err != nil {
		return nil, err
	}
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	host, portStr, _ := net.SplitHostPort(target)
	var port uint16
	fmt.Sscan(portStr, &port)
	req := []byte{5, 1, 0}
	if _, err := c.Write(req); err != nil {
		c.Close()
		return nil, err
	}
	resp := make([]byte, 2)
	if _, err := io.ReadFull(c, resp); err != nil || resp[1] != 0 {
		c.Close()
		return nil, fmt.Errorf("socks greeting: %v %v", resp, err)
	}
	ip := net.ParseIP(host).To4()
	conn := append([]byte{5, 1, 0, 1}, ip...)
	conn = binary.BigEndian.AppendUint16(conn, port)
	if _, err := c.Write(conn); err != nil {
		c.Close()
		return nil, err
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(c, reply); err != nil || reply[1] != 0 {
		c.Close()
		return nil, fmt.Errorf("socks connect: %v %v", reply, err)
	}
	_ = c.SetDeadline(time.Time{})
	return c, nil
}

// roundTrip sends a few bytes and reads them back within a second.
func roundTrip(c net.Conn) error {
	msg := []byte("iceslab-a120")
	_ = c.SetDeadline(time.Now().Add(time.Second))
	defer c.SetDeadline(time.Time{})
	if _, err := c.Write(msg); err != nil {
		return err
	}
	got := make([]byte, len(msg))
	if _, err := io.ReadFull(c, got); err != nil {
		return err
	}
	if string(got) != string(msg) {
		return fmt.Errorf("echo %q", got)
	}
	return nil
}
