package hysteria

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A-154, live against the pinned hysteria (HYSTERIA_BIN): the server from this
// package's render, a client declaring 30/40 Mbps. Both ends log the rate they
// send at ("tx"): above zero is Brutal, zero is BBR. A profile with a
// bandwidth is Brutal on both, one without is BBR on both. The render wrote
// ignoreClientBandwidth always, and both ends logged tx 0 with the bandwidth
// set.
func TestNativeHysteriaIsBrutalWithABandwidthAndBBRWithout(t *testing.T) {
	if hysteriaBin == "" {
		t.Skip("HYSTERIA_BIN not set: the congestion control is not asked of the real core here")
	}
	for _, tc := range []struct {
		name     string
		up, down int
		brutal   bool
	}{
		{"profile bandwidth 100/50", 100, 50, true},
		{"no profile bandwidth", 0, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			a := New(Config{
				ConfigPath:       filepath.Join(dir, "config.yaml"),
				AuthCallbackPort: freeTCP(t),
			}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err := a.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = a.Stop(context.Background()) })
			_ = a.AddUser(core.User{UserID: "u-1", HysteriaPassword: "pw-brutal-not-a-secret"})

			certPEM, keyPEM, _ := pemPair(t)
			if err := writeTLSPair(a.cfg.ConfigPath, certPEM, keyPEM); err != nil {
				t.Fatal(err)
			}
			udp := freeUDP(t)
			blob, err := renderConfig(a.cfg, InboundConfig{Port: udp, TLSCertPEM: certPEM, TLSKeyPEM: keyPEM,
				BrutalUpMbps: tc.up, BrutalDownMbps: tc.down}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(a.cfg.ConfigPath, blob, 0o600); err != nil {
				t.Fatal(err)
			}
			var srvLog lockedBuffer
			srv := exec.Command(hysteriaBin, "server", "-c", a.cfg.ConfigPath)
			srv.Dir = dir
			srv.Stdout, srv.Stderr = &srvLog, &srvLog
			if err := srv.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = srv.Process.Kill(); _ = srv.Wait() })

			clientTx := connectTx(t, udp, "pw-brutal-not-a-secret")
			var serverTx int64 = -1
			for end := time.Now().Add(3 * time.Second); time.Now().Before(end) && serverTx < 0; time.Sleep(50 * time.Millisecond) {
				if m := serverConnectedTx.FindStringSubmatch(srvLog.String()); m != nil {
					serverTx, _ = strconv.ParseInt(m[1], 10, 64)
				}
			}
			if serverTx < 0 {
				t.Fatalf("no \"client connected\" line from the server:\n%s", srvLog.String())
			}
			if got := clientTx > 0 && serverTx > 0; got != tc.brutal {
				t.Fatalf("client tx %d, server tx %d: want Brutal=%v on both\n%s", clientTx, serverTx, tc.brutal, blob)
			}
			if !tc.brutal && (clientTx != 0 || serverTx != 0) {
				t.Fatalf("client tx %d, server tx %d: want BBR on both\n%s", clientTx, serverTx, blob)
			}
		})
	}
}

var (
	clientConnectedTx = regexp.MustCompile(`connected to server.*"tx": (\d+)`)
	serverConnectedTx = regexp.MustCompile(`client connected.*"tx": (\d+)`)
)

// connectTx runs the hysteria client until it connects and returns the tx of
// its "connected to server" line.
func connectTx(t *testing.T, port int, password string) int64 {
	t.Helper()
	dir := t.TempDir()
	cfg := filepath.Join(dir, "client.yaml")
	body := fmt.Sprintf("server: 127.0.0.1:%d\nauth: %s\ntls:\n  insecure: true\nbandwidth:\n  up: 30 mbps\n  down: 40 mbps\nsocks5:\n  listen: 127.0.0.1:0\n", port, password)
	if err := os.WriteFile(cfg, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	var out lockedBuffer
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); {
		cmd := exec.Command(hysteriaBin, "client", "-c", cfg)
		cmd.Dir = dir
		cmd.Stdout, cmd.Stderr = &out, &out
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(50 * time.Millisecond) {
			if m := clientConnectedTx.FindStringSubmatch(out.String()); m != nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				n, _ := strconv.ParseInt(m[1], 10, 64)
				return n
			}
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}
	t.Fatalf("the client never connected:\n%s", out.String())
	return 0
}
