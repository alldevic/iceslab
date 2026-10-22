package singbox

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"math/big"
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
22.10: the pinned sing-box 1.13.14 release is built without with_v2ray_api, and
every user core of sing-box was rendered with experimental.v2ray_api. `sing-box
check` and `run` both refused it ("v2ray api is not included in this build"),
so tuic, anytls, the xray family, hysteria2, shadowsocks and shadowtls on
sing-box never started on a node. No test asked the pinned binary about the
adapter's render. These do, one per protocol.
*/

func singboxBin(t *testing.T) string {
	t.Helper()
	bin := os.Getenv("SINGBOX_BIN")
	if bin == "" {
		t.Skip("SINGBOX_BIN not set: the engine is not asked here")
	}
	return bin
}

func selfSigned(t *testing.T, dir string) (certPath, keyPath string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "n.example.test"},
		DNSNames: []string{"n.example.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	kder, _ := x509.MarshalECPrivateKey(key)
	certPath, keyPath = filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	_ = os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	_ = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}), 0o600)
	return certPath, keyPath
}

func realityKey(t *testing.T, bin string) string {
	t.Helper()
	out, err := exec.Command(bin, "generate", "reality-keypair").CombinedOutput()
	if err != nil {
		t.Fatalf("reality-keypair: %v %s", err, out)
	}
	for _, line := range strings.Split(string(out), "\n") {
		if k, ok := strings.CutPrefix(line, "PrivateKey:"); ok {
			return strings.TrimSpace(k)
		}
	}
	t.Fatalf("no private key in %s", out)
	return ""
}

func ssKey() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.StdEncoding.EncodeToString(b)
}

// Every protocol's render, as the adapter draws it for this binary, through
// the engine's own check.
func TestEveryProtocolRendersAConfigThePinnedEngineTakes(t *testing.T) {
	bin := singboxBin(t)
	dir := t.TempDir()
	cert, key := selfSigned(t, dir)
	users := map[string]userEntry{"u-1": {UUID: "5f0c9a3e-2b7d-4e51-9c8a-1d2e3f4a5b6c", Password: "5f0c9a3e-2b7d-4e51-9c8a-1d2e3f4a5b6c"}}
	cases := map[string]InboundConfig{
		"tuic":     {ListenPort: 29001, ServerName: "n.example.test"},
		"anytls":   {ListenPort: 29002, ServerName: "n.example.test"},
		"hysteria": {ListenPort: 29003},
		"xray": {ListenPort: 29004, Subprotocol: "vless", RealityDest: "www.example.com:443", RealityServerName: "www.example.com",
			RealityPrivateKey: realityKey(t, bin), RealityShortIDsCSV: "0123456789abcdef"},
		"shadowsocks": {ListenPort: 29005, Method: "2022-blake3-aes-128-gcm", ServerPSK: ssKey()},
		"shadowtls":   {ListenPort: 29006, ShadowtlsHandshake: "www.example.com", Method: "2022-blake3-aes-128-gcm", ServerPSK: ssKey()},
	}
	for proto, in := range cases {
		for _, ssm := range []string{"", "127.0.0.1:29099"} {
			if ssm != "" && proto != "shadowsocks" {
				continue
			}
			t.Run(proto+map[bool]string{true: "+ssm", false: ""}[ssm != ""], func(t *testing.T) {
				a := New(Config{Protocol: proto, BinaryPath: bin, StatsListen: "127.0.0.1:29100", SSMListen: ssm},
					slog.New(slog.NewTextHandler(io.Discard, nil)))
				blob, err := a.render(cert, key, a.cfg.StatsListen, in, users)
				if err != nil {
					t.Fatalf("render: %v", err)
				}
				path := filepath.Join(t.TempDir(), "config.json")
				_ = os.WriteFile(path, blob, 0o600)
				if out, err := exec.Command(bin, "check", "-c", path).CombinedOutput(); err != nil {
					t.Fatalf("sing-box check refused the %s render: %v\n%s\n%s", proto, err, out, blob)
				}
				// And two inbounds of the protocol in one process (A-055).
				second := in
				second.ListenPort += 100
				held := []heldInbound{{id: "aaaaaaaa-1", cfg: in}, {id: "bbbbbbbb-2", cfg: second}}
				blob, err = a.renderAll(cert, key, a.cfg.StatsListen, held, users)
				if err != nil {
					t.Fatalf("renderAll: %v", err)
				}
				_ = os.WriteFile(path, blob, 0o600)
				if out, err := exec.Command(bin, "check", "-c", path).CombinedOutput(); err != nil {
					t.Fatalf("sing-box check refused two %s inbounds in one config: %v\n%s\n%s", proto, err, out, blob)
				}
			})
		}
	}
}

// taggedBinary is a stub sing-box whose `version` names these build tags.
func taggedBinary(t *testing.T, tags string) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "sing-box")
	script := "#!/bin/sh\necho 'sing-box version 1.13.14'\necho\necho 'Tags: " + tags + "'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

// The block is drawn by what the binary says it carries, not assumed.
func TestV2rayAPIIsDrawnOnlyForABinaryThatCarriesIt(t *testing.T) {
	for _, tc := range []struct {
		tags string
		want bool
	}{
		{"with_gvisor,with_quic,with_utls,with_clash_api", false},
		{"with_gvisor,with_quic,with_v2ray_api,with_clash_api", true},
	} {
		bin := taggedBinary(t, tc.tags)
		a := New(Config{Protocol: "tuic", BinaryPath: bin, StatsListen: "127.0.0.1:29100"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
		blob, err := a.render("c", "k", a.cfg.StatsListen, InboundConfig{ListenPort: 1}, map[string]userEntry{"u": {UUID: "x", Password: "y"}})
		if err != nil {
			t.Fatal(err)
		}
		if got := strings.Contains(string(blob), "v2ray_api"); got != tc.want {
			t.Errorf("tags %q: v2ray_api drawn=%v, want %v", tc.tags, got, tc.want)
		}
		if got := len(a.ReservedPorts()) > 0; got != tc.want {
			t.Errorf("tags %q: v2ray_api port reserved=%v, want %v", tc.tags, got, tc.want)
		}
	}
}

// Live, pinned engine: shadowsocks on sing-box with its users over ssm-api. A
// user added is let in, another user's open stream survives the add, bytes
// are counted by user, and a removed user is not let in.
func TestShadowsocksUsersAreHandedOverTheAPIWithoutARestart(t *testing.T) {
	bin := singboxBin(t)
	ssPort, ssmPort, socksA, socksB := free(t), free(t), free(t), free(t)
	dir := t.TempDir()
	a := New(Config{
		Protocol:    "shadowsocks",
		BinaryPath:  bin,
		ConfigPath:  filepath.Join(dir, "ss.json"),
		StatsListen: fmt.Sprintf("127.0.0.1:%d", free(t)),
		SSMListen:   fmt.Sprintf("127.0.0.1:%d", ssmPort),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	psk := ssKey()
	const method = "2022-blake3-aes-128-gcm"
	alice := core.User{UserID: "alice", XrayUUID: "11111111-1111-4111-8111-111111111111"}
	bob := core.User{UserID: "bob", XrayUUID: "22222222-2222-4222-8222-222222222222"}
	if err := a.AddUser(alice); err != nil {
		t.Fatal(err)
	}
	wire, _ := json.Marshal(map[string]string{"method": method, "serverPsk": psk})
	if err := a.ApplyInbound(ssPort, wire); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()

	client := func(socks int, u core.User) {
		cfg := fmt.Sprintf(`{"log":{"level":"warn"},"inbounds":[{"type":"socks","listen":"127.0.0.1","listen_port":%d}],
 "outbounds":[{"type":"shadowsocks","server":"127.0.0.1","server_port":%d,"method":%q,"password":%q}]}`,
			socks, ssPort, method, psk+":"+core.DeriveSsPassword(u.XrayUUID, method))
		p := filepath.Join(dir, u.UserID+"-client.json")
		_ = os.WriteFile(p, []byte(cfg), 0o600)
		cmd := exec.Command(bin, "run", "-c", p)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	}
	client(socksA, alice)
	client(socksB, bob)

	echo, _ := net.Listen("tcp", "127.0.0.1:0")
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(c, c); _ = c.Close() }()
		}
	}()
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	defer target.Close()

	var stream net.Conn
	var err error
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		if stream, err = dialSocks(socksA, echo.Addr().String()); err == nil {
			if err = echoOnce(stream, 4096); err == nil {
				break
			}
			stream.Close()
		}
	}
	if err != nil {
		t.Fatalf("alice through ssm-managed shadowsocks: %v", err)
	}
	defer stream.Close()

	if body, err := getVia(socksB, target.Listener.Addr().String()); err == nil && body == "ok" {
		t.Fatal("bob got through before he was added")
	}
	if err := a.AddUser(bob); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	same := a.proc == proc
	a.mu.Unlock()
	if !same {
		t.Fatal("adding a shadowsocks user restarted sing-box")
	}
	if err := echoOnce(stream, 4096); err != nil {
		t.Fatalf("alice's open stream broke when bob was added: %v", err)
	}
	if body, err := getVia(socksB, target.Listener.Addr().String()); err != nil || body != "ok" {
		t.Fatalf("bob not let in after the add: %q %v", body, err)
	}

	st, err := a.GetStats()
	if err != nil || st.NoData || !st.Cumulative {
		t.Fatalf("GetStats %+v %v", st, err)
	}
	var aliceBytes int64
	for _, u := range st.Users {
		if u.UserID == "alice" {
			aliceBytes = u.BytesIn + u.BytesOut
		}
	}
	if aliceBytes < 8192 {
		t.Fatalf("alice counted %d bytes, she moved at least 8192", aliceBytes)
	}

	if err := a.RemoveUser("bob"); err != nil {
		t.Fatal(err)
	}
	if body, err := getVia(socksB, target.Listener.Addr().String()); err == nil && body == "ok" {
		t.Fatal("bob still let in after the removal")
	}
}

func free(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func dialSocks(port int, target string) (net.Conn, error) {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		return nil, err
	}
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	g := make([]byte, 2)
	if _, err := c.Write([]byte{5, 1, 0}); err != nil {
		c.Close()
		return nil, err
	}
	if _, err := io.ReadFull(c, g); err != nil {
		c.Close()
		return nil, err
	}
	host, ps, _ := net.SplitHostPort(target)
	var p int
	fmt.Sscanf(ps, "%d", &p)
	req := append([]byte{5, 1, 0, 1}, net.ParseIP(host).To4()...)
	req = binary.BigEndian.AppendUint16(req, uint16(p))
	if _, err := c.Write(req); err != nil {
		c.Close()
		return nil, err
	}
	r := make([]byte, 10)
	if _, err := io.ReadFull(c, r); err != nil || r[1] != 0 {
		c.Close()
		return nil, fmt.Errorf("connect %v %v", r, err)
	}
	_ = c.SetDeadline(time.Time{})
	return c, nil
}

func echoOnce(c net.Conn, n int) error {
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	msg := []byte(strings.Repeat("z", n))
	if _, err := c.Write(msg); err != nil {
		return err
	}
	buf := make([]byte, n)
	_, err := io.ReadFull(c, buf)
	return err
}

func getVia(socks int, target string) (string, error) {
	c, err := dialSocks(socks, target)
	if err != nil {
		return "", err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(c, "GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", target)
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return string(b), err
}
