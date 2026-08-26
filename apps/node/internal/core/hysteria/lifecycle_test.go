package hysteria

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// The auth callback, asked over the wire instead of read.
//
// Everything about this server was tested by calling handleAuthCallback with a
// httptest recorder — which skips the mux, the listener and the address, i.e.
// all three places the design's one real secret lives. The path IS the secret:
// any local process on the VPS can reach 127.0.0.1:9000, so New() gives the
// handler a random suffix ("/auth/9f3a…") and the doc claims "probes of the
// canonical /auth return 404". Nothing had ever sent that probe.
//
// The second half is a contract between two artefacts. The path the mux serves
// and the path written into /etc/hysteria/config.yaml as `auth.http.url` are
// two separate copies of that secret: one in startAuthCallback, one in
// renderConfig. If they drift, hysteria posts to a URL that 404s and EVERY
// client is rejected — the node stays healthy (the callback is up, the unit is
// active) and nobody can connect. So the URL is not read out of the YAML and
// compared to a string here; it is dialled.
//
// None of it needs the hysteria binary: with BinaryPath empty Start brings up
// the callback and stops there, which is the mode the whole file runs in.

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// freePort binds an ephemeral port and hands back the number after closing it.
// The port has to be CONFIGURED rather than left at 0: New() reads 0 as "not
// set" and substitutes 9000, and a test on the real 9000 would collide with a
// developer's running agent.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a port: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func startedAdapter(t *testing.T, cfg Config) (*Adapter, int) {
	t.Helper()
	port := freePort(t)
	cfg.AuthCallbackHost = "127.0.0.1"
	cfg.AuthCallbackPort = port
	a := New(cfg, quietLogger())
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	waitServing(t, a, port)
	return a, port
}

// waitServing blocks until the callback has ANSWERED, not until the port
// accepts.
//
// The difference is the whole reason this helper exists. Start hands the
// listener to a goroutine and returns, so between Start returning and
// http.Server.Serve running there is a window in which the kernel completes
// connections out of the listen backlog and no Go code has run at all. A
// TCP dial is satisfied by that window; an HTTP round-trip is not. The first
// version of this file dialled, and the reward was a Stop assertion that
// failed depending on the scheduler — Shutdown reached a server with no
// tracked listener, returned instantly, and the port was still open.
func waitServing(t *testing.T, a *Adapter, port int) {
	t.Helper()
	url := fmt.Sprintf("http://127.0.0.1:%d%s", port, a.cfg.AuthCallbackPath)
	client := &http.Client{Timeout: 500 * time.Millisecond}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := client.Post(url, "application/json", strings.NewReader(`{"auth":"probe"}`))
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("auth callback never answered on %s", url)
}

// postAuth sends the shape hysteria-server sends and returns status + decoded body.
func postAuth(t *testing.T, url, password string) (int, AuthResponse) {
	t.Helper()
	body := strings.NewReader(fmt.Sprintf(`{"addr":"1.2.3.4:5678","auth":%q,"tx":0}`, password))
	req, err := http.NewRequest(http.MethodPost, url, body)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer resp.Body.Close()
	var out AuthResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestStart_ServesOnlyTheSecretPath(t *testing.T) {
	a, port := startedAdapter(t, Config{})
	_ = a.AddUser(core.User{UserID: "u-1", Username: "alice", HysteriaPassword: "secret-pw"})

	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	// The generated path answers…
	code, resp := postAuth(t, base+a.cfg.AuthCallbackPath, "secret-pw")
	if code != http.StatusOK || !resp.OK || resp.ID != "u-1" {
		t.Errorf("secret path: got status=%d ok=%v id=%q, want 200/true/u-1", code, resp.OK, resp.ID)
	}

	// …and the canonical one, which is what a local attacker would try first,
	// does not. This is the claim in the AuthCallbackPath doc comment, sent as
	// a request for the first time.
	if code, _ := postAuth(t, base+"/auth", "secret-pw"); code != http.StatusNotFound {
		t.Errorf("probe of the canonical /auth: got status %d, want 404 — the random suffix is not a secret if /auth answers too", code)
	}

	// Control: the 404 above must come from routing, not from the server being
	// generally unable to answer. A wrong password on the RIGHT path is a 200
	// with ok:false, and telling those two apart is the whole point.
	if code, resp := postAuth(t, base+a.cfg.AuthCallbackPath, "wrong-pw"); code != http.StatusOK || resp.OK {
		t.Errorf("wrong password on the secret path: got status=%d ok=%v, want 200/false", code, resp.OK)
	}
}

// The path is decided twice — once for the mux, once for the YAML. Rather than
// compare the two strings, take the URL hysteria would be told to use and use it.
func TestStart_TheURLWrittenIntoConfigIsTheURLThatAnswers(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	a, _ := startedAdapter(t, Config{
		Hostname:   "node.example.com",
		ACMEEmail:  "ops@example.com",
		ConfigPath: cfgPath,
		// No ServiceUnit: ApplyInbound writes the file and skips systemctl.
	})
	_ = a.AddUser(core.User{UserID: "u-7", Username: "dave", HysteriaPassword: "pw-7"})

	if err := a.ApplyInbound(443, json.RawMessage(`{}`)); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	blob, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read rendered config: %v", err)
	}

	m := regexp.MustCompile(`(?m)^\s*url:\s*(http://\S+)\s*$`).FindStringSubmatch(string(blob))
	if m == nil {
		t.Fatalf("no auth.http.url in the rendered config; the shape changed and this test compares nothing:\n%s", blob)
	}
	url := m[1]

	code, resp := postAuth(t, url, "pw-7")
	if code != http.StatusOK || !resp.OK || resp.ID != "u-7" {
		t.Errorf("the URL hysteria is configured to call (%s) answered status=%d ok=%v id=%q; "+
			"a drift here rejects every client while the node still reports healthy",
			url, code, resp.OK, resp.ID)
	}
}

func TestStart_RefusesAPublicTrafficAPIAndLeavesNothingListening(t *testing.T) {
	port := freePort(t)
	a := New(Config{
		AuthCallbackHost:   "127.0.0.1",
		AuthCallbackPort:   port,
		TrafficStatsListen: "0.0.0.0:9999",
	}, quietLogger())

	err := a.Start(context.Background())
	if err == nil {
		t.Fatal("Start accepted a traffic API bound to 0.0.0.0")
	}
	if !strings.Contains(err.Error(), "TrafficStatsListen") {
		t.Errorf("error should name the setting, got %v", err)
	}
	// The refusal has to happen BEFORE the callback binds, or a failed Start
	// leaves a listener nobody owns and the next Start fails on "address in use".
	if a.Healthy() {
		t.Error("Healthy after a refused Start")
	}
	conn, dialErr := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
	if dialErr == nil {
		conn.Close()
		t.Errorf("a refused Start left something listening on 127.0.0.1:%d", port)
	}
}

func TestStop_ClosesThePortAndIsIdempotent(t *testing.T) {
	a, port := startedAdapter(t, Config{})

	if err := a.Stop(context.Background()); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if a.Healthy() {
		t.Error("Healthy after Stop")
	}
	// Physically gone, not merely nil-ed out: a Shutdown that never happened
	// would leave a live goroutine holding :port, and the next Start would fail.
	if conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond); err == nil {
		conn.Close()
		t.Errorf("127.0.0.1:%d still accepts connections after Stop", port)
	}

	// A second Stop is what the agent does on a shutdown path that already ran.
	if err := a.Stop(context.Background()); err != nil {
		t.Errorf("second Stop: %v", err)
	}
}

func TestStop_BeforeStartIsNotAnError(t *testing.T) {
	a := New(Config{}, quietLogger())
	if err := a.Stop(context.Background()); err != nil {
		t.Errorf("Stop before Start: %v", err)
	}
}

// After Stop the port is free, so the same adapter can come back up. This is
// the restart path the agent takes on SIGHUP-style reconfiguration.
func TestStartAfterStopRebinds(t *testing.T) {
	a, port := startedAdapter(t, Config{})
	if err := a.Stop(context.Background()); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start again: %v", err)
	}
	waitServing(t, a, port)
	if !a.Healthy() {
		t.Error("Healthy false after a restart")
	}
}

// netListen is the one line that touches the network stack, split out so the
// rest can be faked. Both of its outcomes, asked directly.
func TestNetListen(t *testing.T) {
	ln, err := netListen("127.0.0.1:0")
	if err != nil {
		t.Fatalf("netListen on an ephemeral port: %v", err)
	}
	defer ln.Close()
	if _, ok := ln.Addr().(*net.TCPAddr); !ok {
		t.Errorf("netListen returned a %T, want a TCP listener", ln.Addr())
	}

	if _, err := netListen("256.256.256.256:1"); err == nil {
		t.Error("netListen accepted an address that cannot be bound")
	}
}
