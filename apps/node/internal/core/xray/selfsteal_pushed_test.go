package xray

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

/*
A-129, 22.10: the self-steal fallback was started from the install-time inbound
only. Every pushed inbound (all of them, on a node provisioned by the panel)
rendered dest = 127.0.0.1:8443 with nothing listening there, and REALITY, which
dials dest at the start of every handshake, closed every connection. `xray
-test` sees nothing wrong: dest is just an address.
*/

func selfStealWire(id, name, key string, port int) []byte {
	return []byte(fmt.Sprintf(`{
		"inboundId": %q,
		"realityMode": "self-steal",
		"realityServerNames": [%q],
		"realityPrivateKey": %q,
		"realityShortIds": ["0123456789abcdef"]
	}`, id, name, key))
}

// ephemeralSelfSteal points the fallback at a free loopback port for one test.
func ephemeralSelfSteal(t *testing.T) *string {
	t.Helper()
	bound := new(string)
	orig := selfStealListen
	selfStealListen = func(string) (net.Listener, error) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err == nil {
			*bound = ln.Addr().String()
		}
		return ln, err
	}
	t.Cleanup(func() { selfStealListen = orig })
	return bound
}

// The audit's proof: a pushed self-steal inbound, an empty install-time one,
// and the fallback has to be up.
func TestAPushedSelfStealInboundBringsUpTheFallback(t *testing.T) {
	ephemeralSelfSteal(t)
	c := &fakeCore{}
	dir := t.TempDir()
	a := New(Config{
		ConfigPath: filepath.Join(dir, "config.json"),
		BinaryPath: stubBinary(t, dir),
		RunCmd:     c.run,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { _ = a.Stop(context.Background()) })

	key := "aGVsbG8td29ybGQtdGhpcy1pcy1hLWZha2Uta2V5MDA"
	if err := a.ApplyInbound(443, selfStealWire("aaaaaaaa-1111-4000-8000-000000000001", "a.example.test", key, 443)); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	a.mu.Lock()
	ss := a.selfSteal
	a.mu.Unlock()
	if ss == nil {
		t.Fatal("a pushed self-steal inbound left the fallback down: REALITY's dest answers nobody")
	}
}

// One name, two different pages: the fallback tells sites apart by SNI only,
// so the second inbound is refused before it is stored.
func TestTwoSelfStealInboundsCannotClaimOneNameWithDifferentPages(t *testing.T) {
	a := multiAdapter(t)
	key := "aGVsbG8td29ybGQtdGhpcy1pcy1hLWZha2Uta2V5MDA"
	first := `{"inboundId":"aaaaaaaa-1","realityMode":"self-steal","realityServerNames":["a.example.test"],"realityPrivateKey":"` + key + `","realityShortIds":["01"]}`
	second := `{"inboundId":"bbbbbbbb-2","realityMode":"self-steal","realityServerNames":["A.example.test"],"realityPrivateKey":"` + key + `","realityShortIds":["01"],"realityFallbackUpstream":"https://elsewhere.example"}`
	if err := a.ApplyInbound(443, []byte(first)); err != nil {
		t.Fatalf("first: %v", err)
	}
	err := a.ApplyInbound(8443, []byte(second))
	if err == nil || !strings.Contains(err.Error(), "a.example.test") {
		t.Fatalf("expected the clash to be refused by name, got %v", err)
	}
	a.mu.Lock()
	_, held := a.inbounds["bbbbbbbb-2"]
	a.mu.Unlock()
	if held {
		t.Fatal("the refused inbound was stored")
	}
}

// Live, with the real core: two pushed self-steal inbounds on one node, each
// with its own name. A REALITY client gets through the second one, and a
// prober that is not REALITY sees, on each port, the certificate for that
// inbound's own name, which is the fallback answering behind REALITY.
// Skipped without XRAY_BIN. Needs 127.0.0.1:8443 free: the render points
// REALITY at that fixed address.
func TestLiveRealityClientThroughAPushedSelfStealInbound(t *testing.T) {
	bin := os.Getenv("XRAY_BIN")
	if bin == "" {
		t.Skip("XRAY_BIN not set: the core is not asked here")
	}
	priv, pub := x25519Pair(t, bin)
	portA, portB, api, socks := freePort(t), freePort(t), freePort(t), freePort(t)

	dir := t.TempDir()
	a := New(Config{
		ConfigPath: filepath.Join(dir, "config.json"),
		BinaryPath: bin,
		Inbound:    InboundConfig{ApiPort: api, ListenHost: "127.0.0.1"},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })

	const uuid = "5f0c9a3e-2b7d-4e51-9c8a-1d2e3f4a5b6c"
	if err := a.AddUser(core.User{UserID: "alice", XrayUUID: uuid}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if err := a.ApplyInbound(portA, selfStealWire("aaaaaaaa-1111-4000-8000-000000000001", "a.example.test", priv, portA)); err != nil {
		t.Fatalf("ApplyInbound A: %v", err)
	}
	if err := a.ApplyInbound(portB, selfStealWire("bbbbbbbb-2222-4000-8000-000000000002", "b.example.test", priv, portB)); err != nil {
		t.Fatalf("ApplyInbound B: %v", err)
	}

	// A prober: plain TLS, no REALITY auth. REALITY forwards it to dest, and
	// the certificate that comes back is the fallback's for that name.
	for port, name := range map[int]string{portA: "a.example.test", portB: "b.example.test"} {
		cn := proberCN(t, port, name)
		if cn != name {
			t.Fatalf("prober on %d with SNI %s saw CN %q, want the fallback's %q", port, name, cn, name)
		}
	}

	// The honest client: a second xray with a REALITY outbound to inbound B.
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "through-reality")
	}))
	defer target.Close()
	client := filepath.Join(dir, "client.json")
	clientCfg := fmt.Sprintf(`{
	  "log": {"loglevel": "warning"},
	  "inbounds": [{"listen": "127.0.0.1", "port": %d, "protocol": "socks", "settings": {"udp": false}}],
	  "outbounds": [{
	    "protocol": "vless",
	    "settings": {"vnext": [{"address": "127.0.0.1", "port": %d, "users": [{"id": %q, "encryption": "none"}]}]},
	    "streamSettings": {"network": "raw", "security": "reality",
	      "realitySettings": {"serverName": "b.example.test", "publicKey": %q, "shortId": "0123456789abcdef", "fingerprint": "chrome"}}
	  }]
	}`, socks, portB, uuid, pub)
	if err := os.WriteFile(client, []byte(clientCfg), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "run", "-c", client)
	var clientLog strings.Builder
	cmd.Stdout, cmd.Stderr = &clientLog, &clientLog
	if err := cmd.Start(); err != nil {
		t.Fatalf("start client: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })

	body, err := getThroughSocks(socks, target.Listener.Addr().String())
	if err != nil {
		t.Fatalf("no traffic through the pushed self-steal inbound: %v\nclient log:\n%s", err, clientLog.String())
	}
	if !strings.Contains(body, "through-reality") {
		t.Fatalf("unexpected body through REALITY: %q", body)
	}
}

func x25519Pair(t *testing.T, bin string) (priv, pub string) {
	t.Helper()
	out, err := exec.Command(bin, "x25519").CombinedOutput()
	if err != nil {
		t.Fatalf("xray x25519: %v %s", err, out)
	}
	for _, line := range strings.Split(string(out), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch {
		case strings.HasPrefix(k, "PrivateKey"), strings.HasPrefix(k, "Private key"):
			priv = v
		case strings.Contains(k, "PublicKey"), strings.HasPrefix(k, "Public key"):
			pub = v
		}
	}
	if priv == "" || pub == "" {
		t.Fatalf("cannot read the key pair from:\n%s", out)
	}
	return priv, pub
}

// proberCN retries while xray comes up and returns the leaf's CN.
func proberCN(t *testing.T, port int, sni string) string {
	t.Helper()
	var lastErr error
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: time.Second}, "tcp",
			fmt.Sprintf("127.0.0.1:%d", port), &tls.Config{ServerName: sni, InsecureSkipVerify: true})
		if err != nil {
			lastErr = err
			continue
		}
		state := conn.ConnectionState()
		_ = conn.Close()
		if len(state.PeerCertificates) > 0 {
			return state.PeerCertificates[0].Subject.CommonName
		}
	}
	t.Fatalf("prober never completed a handshake on %d: %v", port, lastErr)
	return ""
}

// getThroughSocks does one HTTP GET through a SOCKS5 proxy, retrying while the
// client comes up.
func getThroughSocks(socksPort int, target string) (string, error) {
	var lastErr error
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		body, err := socksGet(socksPort, target)
		if err == nil {
			return body, nil
		}
		lastErr = err
	}
	return "", lastErr
}

func socksGet(socksPort int, target string) (string, error) {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", socksPort), time.Second)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte{5, 1, 0}); err != nil {
		return "", err
	}
	greet := make([]byte, 2)
	if _, err := io.ReadFull(conn, greet); err != nil || greet[1] != 0 {
		return "", fmt.Errorf("socks greeting: %v %v", greet, err)
	}
	host, portStr, _ := net.SplitHostPort(target)
	var port int
	fmt.Sscanf(portStr, "%d", &port)
	ip := net.ParseIP(host).To4()
	req := append([]byte{5, 1, 0, 1}, ip...)
	req = binary.BigEndian.AppendUint16(req, uint16(port))
	if _, err := conn.Write(req); err != nil {
		return "", err
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(conn, reply); err != nil || reply[1] != 0 {
		return "", fmt.Errorf("socks connect: %v %v", reply, err)
	}
	if _, err := fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", target); err != nil {
		return "", err
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return string(b), err
}
