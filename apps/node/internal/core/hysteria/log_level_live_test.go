package hysteria

import (
	"context"
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

// A-265, stand 26.10 p.23 on aeza-de-01, live against the pinned hysteria
// (HYSTERIA_BIN): a client asks for a TCP target nobody listens on, and the
// server's journal is read. At warn it says "TCP error" with the client's
// address, the user's id and the target (app/cmd/server.go:1820 at app/v2.12.3):
// the instrument, which shows the test can see the line. At LogLevelEnv, the
// level the agent gives the core, none of it is there.
func TestLiveTheCoreLevelWritesNoClientOnABrokenConnection(t *testing.T) {
	if hysteriaBin == "" {
		t.Skip("HYSTERIA_BIN not set: the log level is not asked of the real core here")
	}
	journal := func(t *testing.T, levelEnv string) *lockedBuffer {
		t.Helper()
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
		_ = a.AddUser(core.User{UserID: "u-dora", HysteriaPassword: "pw-dora-not-a-secret"})

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
		var out lockedBuffer
		srv := exec.Command(hysteriaBin, "server", "-c", a.cfg.ConfigPath)
		srv.Dir = dir
		srv.Env = append(os.Environ(), levelEnv)
		srv.Stdout, srv.Stderr = &out, &out
		if err := srv.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = srv.Process.Kill(); _ = srv.Wait() })
		// The server says nothing at error when it comes up: wait for its UDP
		// port to be taken instead of for a line.
		for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(50 * time.Millisecond) {
			c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: udp})
			if err != nil {
				break
			}
			c.Close()
			if time.Now().After(deadline) {
				t.Fatalf("the server did not bind %d: %s", udp, out.String())
			}
		}

		socks := freeTCP(t)
		cfg := filepath.Join(t.TempDir(), "client.yaml")
		body := fmt.Sprintf("server: 127.0.0.1:%d\nauth: pw-dora-not-a-secret\ntls:\n  insecure: true\nsocks5:\n  listen: 127.0.0.1:%d\n", udp, socks)
		if err := os.WriteFile(cfg, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		run(t, filepath.Dir(cfg), "client", "", hysteriaBin, "client", "-c", cfg)

		// The client is in first: a stream to an echo server goes through,
		// so a refused CONNECT below is the server's dial, not a client that
		// has not reached the server yet (which a loaded runner showed).
		echo := echoServer(t)
		for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(200 * time.Millisecond) {
			c, err := socksDial(socks, echo)
			if err == nil {
				err = roundTrip(c)
				c.Close()
				if err == nil {
					break
				}
			}
			if time.Now().After(deadline) {
				t.Fatalf("no stream through the client: %v\n%s", err, out.String())
			}
		}
		// A target nobody listens on: the server's dial is refused, which is
		// the TCP error the stand saw.
		closed := fmt.Sprintf("127.0.0.1:%d", freeTCP(t))
		if c, err := socksDial(socks, closed); err == nil {
			c.Close()
			t.Fatalf("a CONNECT to %s went through", closed)
		}
		return &out
	}

	// The instrument: at warn the line comes, with the user. Waited for as an
	// event: the socks reply and the server's log line race.
	warn := journal(t, "HYSTERIA_LOG_LEVEL=warn")
	for deadline := time.Now().Add(10 * time.Second); !(strings.Contains(warn.String(), "TCP error") && strings.Contains(warn.String(), "u-dora")); time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("at warn the server wrote no TCP error with the user, so this test cannot see the line:\n%s", warn.String())
		}
	}
	// At the agent's level: the same broken connection, and the window the
	// instrument needed to see its line passes with none of it written.
	quiet := journal(t, LogLevelEnv)
	for end := time.Now().Add(2 * time.Second); time.Now().Before(end); time.Sleep(100 * time.Millisecond) {
		for _, leak := range []string{"TCP error", "u-dora", `"addr"`, "reqAddr"} {
			if got := quiet.String(); strings.Contains(got, leak) {
				t.Fatalf("at %s the server's journal carries %q:\n%s", LogLevelEnv, leak, got)
			}
		}
	}
}
