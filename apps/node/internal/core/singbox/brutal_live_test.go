package singbox

import (
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// A-154, live: the hysteria2 render on the pinned sing-box, and the native
// hysteria client (HYSTERIA_BIN) declaring 30/40 Mbps. The client's
// "connected to server" line carries the rate it sends at: above zero is
// Brutal, zero is BBR. A profile with a bandwidth is Brutal, one without is
// BBR, the same rule as on native hysteria (hysteria/brutal_live_test.go).
// Here the outcome did not change with A-154 (beside up/down sing-box let the
// flag go, Brutal both before and after, measured 22.10 by the download rate
// too: 4.9 MB/s at the client's 40 Mbps either way); the render dropped a pair
// sing-box documents as a conflict, and this guards that the rule holds.
func TestHysteria2OnSingboxIsBrutalWithABandwidthAndBBRWithout(t *testing.T) {
	bin := singboxBin(t)
	hy := os.Getenv("HYSTERIA_BIN")
	if hy == "" {
		t.Skip("HYSTERIA_BIN not set: no hysteria client to ask here")
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
			cert, key := selfSigned(t, dir)
			udp := freeUDPPort(t)
			a := New(Config{Protocol: "hysteria", BinaryPath: bin}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			users := map[string]userEntry{"u-1": {Password: "pw-hy2-not-a-secret"}}
			blob, err := a.render(cert, key, "", InboundConfig{ListenPort: udp, BrutalUpMbps: tc.up, BrutalDownMbps: tc.down}, users)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "config.json")
			if err := os.WriteFile(path, blob, 0o600); err != nil {
				t.Fatal(err)
			}
			srv := exec.Command(bin, "run", "-c", path)
			if err := srv.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = srv.Process.Kill(); _ = srv.Wait() })

			tx := clientTx(t, hy, udp, "pw-hy2-not-a-secret")
			if got := tx > 0; got != tc.brutal {
				t.Fatalf("client tx %d: Brutal=%v, want %v\n%s", tx, got, tc.brutal, blob)
			}
		})
	}
}

// clientTx runs the hysteria client until it connects and returns the tx of
// its "connected to server" line.
func clientTx(t *testing.T, hy string, port int, password string) int64 {
	t.Helper()
	dir := t.TempDir()
	cfg := filepath.Join(dir, "client.yaml")
	body := fmt.Sprintf("server: 127.0.0.1:%d\nauth: %s\ntls:\n  insecure: true\nbandwidth:\n  up: 30 mbps\n  down: 40 mbps\nsocks5:\n  listen: 127.0.0.1:0\n", port, password)
	if err := os.WriteFile(cfg, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	var out syncBuffer
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); {
		cmd := exec.Command(hy, "client", "-c", cfg)
		cmd.Dir = dir
		cmd.Stdout, cmd.Stderr = &out, &out
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(50 * time.Millisecond) {
			if m := connectedTx.FindStringSubmatch(out.String()); m != nil {
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

var connectedTx = regexp.MustCompile(`connected to server.*"tx": (\d+)`)

type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}
