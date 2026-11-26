package singbox

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The real sing-box answers QueryStats under the name the agent asks for.
// Runs a with_v2ray_api build (SINGBOX_BIN) with a direct inbound that lists
// one user and reads the counters back; before f08-09 the xray CLI got
// "unknown service" from the same engine.
func TestQueryUserStatsAgainstTheRealSingbox(t *testing.T) {
	bin := singboxBin(t)
	if !hasBuildTag(mustOut(t, bin, "version"), "with_v2ray_api") {
		t.Skip("SINGBOX_BIN has no with_v2ray_api")
	}
	apiPort, inPort := freePort(t), freePort(t)
	apiAddr := net.JoinHostPort("127.0.0.1", apiPort)
	cfg := map[string]any{
		"log": map[string]any{"level": "warn"},
		"inbounds": []any{map[string]any{
			"type": "mixed", "tag": "in", "listen": "127.0.0.1", "listen_port": atoi(inPort),
			"users": []any{map[string]any{"username": "u1", "password": "p"}},
		}},
		"outbounds": []any{map[string]any{"type": "direct", "tag": "direct"}},
		"experimental": map[string]any{"v2ray_api": map[string]any{
			"listen": apiAddr,
			"stats":  map[string]any{"enabled": true, "users": []any{"u1"}},
		}},
	}
	blob, _ := json.Marshal(cfg)
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, blob, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "run", "-c", path)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sing-box: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })

	// sing-box makes a user's counters on its first traffic: send some through
	// the inbound, then read them back.
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(bytes.Repeat([]byte("x"), 64<<10))
	}))
	defer origin.Close()
	proxy, _ := url.Parse("http://u1:p@127.0.0.1:" + inPort)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxy)}, Timeout: 3 * time.Second}

	var (
		got map[string]userByteCounters
		err error
	)
	for i := 0; i < 50; i++ {
		if resp, e := client.Get(origin.URL); e == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if got, err = queryUserStats(context.Background(), apiAddr); err == nil && got["u1"].DownlinkBytes > 0 {
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("queryUserStats against the real sing-box: %v", err)
	}
	if got["u1"].DownlinkBytes < 64<<10 || got["u1"].UplinkBytes == 0 {
		t.Errorf("counters %+v: u1 should show the 64 KiB it downloaded", got)
	}
}

func mustOut(t *testing.T, bin string, args ...string) string {
	t.Helper()
	out, err := exec.Command(bin, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v", bin, args, err)
	}
	return string(out)
}

func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	_, p, _ := net.SplitHostPort(l.Addr().String())
	return p
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}
