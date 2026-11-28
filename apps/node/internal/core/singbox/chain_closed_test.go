package singbox

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

/*
19.15, item 4: an entry whose hand-off was not accepted is drawn closed, not with
the `direct` outbound it would draw with no cascade at all. The listeners stay,
the handshake passes, every proxied connection is rejected at once.
*/

var _ core.CascadeCloser = (*Adapter)(nil)

func closedRender(t *testing.T, proto string) []byte {
	t.Helper()
	a, held, users := chainRenderFixture(proto)
	blob, err := a.renderAllWith("c", "k", "", held, users, &ChainHandoff{Closed: true, Why: "x"})
	if err != nil {
		t.Fatalf("%s: %v", proto, err)
	}
	return blob
}

func TestAClosedEntryRejectsEverythingAndDrawsNoWayOut(t *testing.T) {
	for _, proto := range []string{"tuic", "anytls", "shadowtls", "shadowsocks"} {
		blob := closedRender(t, proto)
		r := readRendered(t, blob)
		rules, _ := r.Route["rules"].([]any)
		if len(rules) != 1 || fmt.Sprint(rules[0]) != "map[action:reject]" {
			t.Errorf("%s: route %v, want the one reject rule", proto, r.Route)
		}
		if _, final := r.Route["final"]; final {
			t.Errorf("%s: a closed entry names a final outbound %v", proto, r.Route)
		}
		for _, o := range r.Outbounds {
			if o["type"] == "socks" {
				t.Errorf("%s: a closed entry draws the chain's socks %v", proto, o)
			}
		}
		// The listeners are untouched.
		var doc struct {
			Inbounds []map[string]any `json:"inbounds"`
		}
		_ = json.Unmarshal(blob, &doc)
		if len(doc.Inbounds) == 0 {
			t.Errorf("%s: no inbound is left to take the handshake", proto)
		}
	}
}

func TestAnEntryTheAdapterCannotTakeIsClosedAndLiftedByTheNextHandoff(t *testing.T) {
	a, cfgPath, starts := chainStubAdapter(t, "anytls")
	if err := a.ApplyInbound(9443, []byte(startupWire)); err != nil {
		t.Fatal(err)
	}
	if runs(t, starts) != 1 {
		t.Fatalf("runs %d, want 1", runs(t, starts))
	}

	// First application, a hand-off the validator refuses: closed, not direct.
	if err := a.ApplyCascade(json.RawMessage(`{"port":0,"username":"u","password":"p"}`)); err == nil {
		t.Fatal("a refused hand-off must still come back as an error")
	}
	blob, _ := os.ReadFile(cfgPath)
	if strings.Contains(string(blob), `"direct"`) && !strings.Contains(string(blob), `"reject"`) {
		t.Fatalf("a refused first hand-off drew direct: %s", blob)
	}
	if !strings.Contains(string(blob), `"action": "reject"`) {
		t.Fatalf("no reject rule: %s", blob)
	}
	if why := a.CascadeClosed(); !strings.Contains(why, "port 0") {
		t.Fatalf("closed reason %q does not say why", why)
	}
	if runs(t, starts) != 2 {
		t.Fatalf("runs %d, want 2 (the closed draw restarts the core once)", runs(t, starts))
	}
	// The same refusal again: still closed, no restart.
	_ = a.ApplyCascade(json.RawMessage(`{"port":0,"username":"u","password":"p"}`))
	if runs(t, starts) != 2 {
		t.Fatalf("a repeated refusal restarted the core (%d runs)", runs(t, starts))
	}

	// An accepted hand-off lifts it, without restarting the agent.
	if err := a.ApplyCascade(json.RawMessage(handoffWire)); err != nil {
		t.Fatal(err)
	}
	blob, _ = os.ReadFile(cfgPath)
	if strings.Contains(string(blob), `"reject"`) || readRendered(t, blob).Route["final"] != "chain" {
		t.Fatalf("the accepted hand-off did not lift the closing: %s", blob)
	}
	if a.CascadeClosed() != "" {
		t.Fatal("still reported closed")
	}

	// A refusal while a hand-off is held keeps the held one.
	if err := a.ApplyCascade(json.RawMessage(`{"port":0}`)); err == nil {
		t.Fatal("refusal not reported")
	}
	blob, _ = os.ReadFile(cfgPath)
	if readRendered(t, blob).Route["final"] != "chain" || a.CascadeClosed() != "" {
		t.Fatalf("a refused hand-off replaced the held one: %s", blob)
	}

	// Closed again by the server, then lifted by a real nil.
	a2, cfg2, _ := chainStubAdapter(t, "tuic")
	if err := a2.ApplyInbound(9444, []byte(startupWire)); err != nil {
		t.Fatal(err)
	}
	if err := a2.CloseCascade("userCore: engines do not match"); err != nil {
		_ = err // the cause comes back by contract
	}
	blob, _ = os.ReadFile(cfg2)
	if !strings.Contains(string(blob), `"action": "reject"`) || !strings.Contains(a2.CascadeClosed(), "engines do not match") {
		t.Fatalf("CloseCascade did not close: %s", blob)
	}
	if err := a2.ApplyCascade(nil); err != nil {
		t.Fatal(err)
	}
	blob, _ = os.ReadFile(cfg2)
	r := readRendered(t, blob)
	if strings.Contains(string(blob), `"reject"`) || r.Route != nil || r.Outbounds[0]["type"] != "direct" {
		t.Fatalf("a real nil must bring back the base render: %s", blob)
	}
}

// A hand-off refused before any inbound is remembered closed, and the first
// render of the inbound is closed too: no window with a direct way out.
func TestARefusedHandoffBeforeTheInboundDrawsTheFirstRenderClosed(t *testing.T) {
	a, cfgPath, _ := chainStubAdapter(t, "anytls")
	_ = a.ApplyCascade(json.RawMessage(`{"port":0}`))
	if err := a.ApplyInbound(9443, []byte(startupWire)); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(blob), `"action": "reject"`) {
		t.Fatalf("first render is not closed: %s", blob)
	}
}

// The real engine: it takes the closed render, the handshake passes, and a
// request through the entry never reaches the lab; the same entry without the
// closing carries it (the control that says the harness can see a leak).
func TestARealEngineClosedEntryTakesTheHandshakeAndCarriesNothing(t *testing.T) {
	bin := singboxBin(t)
	var hits atomic.Int64
	lab := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte("lab"))
	}))
	defer lab.Close()

	method := "2022-blake3-aes-128-gcm"
	dir := t.TempDir()
	cert, key := selfSigned(t, dir)

	start := func(cfg []byte, name string) {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, cfg, 0o600); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command(bin, "check", "-c", path).CombinedOutput(); err != nil {
			t.Fatalf("sing-box check refused %s: %v\n%s\n%s", name, err, out, cfg)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cmd := exec.CommandContext(ctx, bin, "run", "-c", path)
		if err := cmd.Start(); err != nil {
			cancel()
			t.Fatal(err)
		}
		t.Cleanup(func() { cancel(); _ = cmd.Wait() })
	}
	waitPort := func(port string) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if c, err := net.DialTimeout("tcp", "127.0.0.1:"+port, 200*time.Millisecond); err == nil {
				_ = c.Close()
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("nothing listens on %s", port)
	}
	// One entry and one client, on ports of their own; what the request does.
	through := func(name string, handoff *ChainHandoff) error {
		t.Helper()
		psk, userPass := ssKey(), "u-pass"
		srvPort, httpPort := freePort(t), freePort(t)
		a := New(Config{Protocol: "shadowsocks", BinaryPath: bin}, slog.New(slog.NewTextHandler(io.Discard, nil)))
		held := []heldInbound{{id: "a", cfg: InboundConfig{ListenPort: atoi(srvPort), Method: method, ServerPSK: psk}}}
		users := map[string]userEntry{"alice": {UUID: "u-a", Password: userPass}}
		server, err := a.renderAllWith(cert, key, "", held, users, handoff)
		if err != nil {
			t.Fatal(err)
		}
		start(server, name+"-server.json")
		client, _ := json.Marshal(map[string]any{
			"log":      map[string]any{"level": "warn"},
			"inbounds": []any{map[string]any{"type": "http", "tag": "in", "listen": "127.0.0.1", "listen_port": atoi(httpPort)}},
			"outbounds": []any{map[string]any{
				"type": "shadowsocks", "tag": "out", "server": "127.0.0.1", "server_port": atoi(srvPort),
				"method": method, "password": psk + ":" + core.DeriveSsPassword(userPass, method),
			}},
		})
		start(client, name+"-client.json")
		waitPort(srvPort)
		waitPort(httpPort)
		proxy, _ := url.Parse("http://127.0.0.1:" + httpPort)
		hc := &http.Client{Timeout: 4 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(proxy)}}
		resp, err := hc.Get(lab.URL)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return fmt.Errorf("status %d", resp.StatusCode)
		}
		return nil
	}

	if err := through("open", nil); err != nil || hits.Load() != 1 {
		t.Fatalf("control: the open entry did not carry the request (err %v, hits %d)", err, hits.Load())
	}
	if err := through("closed", &ChainHandoff{Closed: true, Why: "test"}); err == nil {
		t.Fatal("a closed entry carried a request")
	}
	if hits.Load() != 1 {
		t.Fatalf("the lab saw %d requests, the closed entry let one out", hits.Load())
	}
}
