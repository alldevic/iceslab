package hysteria

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

/*
19.15, item 4: a hysteria entry whose hand-off was not accepted is drawn closed
(`acl.inline: [reject(all)]`, no outbound at all), not with the `direct` one it
draws with no cascade. The listener stays, the handshake passes, every request is
rejected.
*/

var _ core.CascadeCloser = (*Adapter)(nil)

var closedHandoff = &ChainHandoff{Closed: true, Why: "test"}

func TestAClosedEntryRendersRejectAllAndNoWayOut(t *testing.T) {
	blob, err := renderConfig(goldenCfg, goldenInbound, closedHandoff)
	if err != nil {
		t.Fatal(err)
	}
	got := string(blob)
	if !strings.HasSuffix(got, "\nacl:\n  inline:\n    - reject(all)\n") {
		t.Errorf("the render does not end in the reject rule:\n%s", got)
	}
	for _, forbidden := range []string{"outbounds:", "type: direct", "type: socks5", "resolver:"} {
		if strings.Contains(got, forbidden) {
			t.Errorf("a closed entry draws %q:\n%s", forbidden, got)
		}
	}
	// Everything before it is the base render's: only the way out differs.
	base, _ := renderConfig(goldenCfg, goldenInbound, nil)
	direct := "\noutbounds:\n  - name: direct\n    type: direct\n    direct:\n      mode: \"46\"\n"
	if !strings.HasPrefix(got, strings.TrimSuffix(string(base), direct)) {
		t.Error("the closed render changed something other than the way out")
	}
}

func TestEngineAcceptsTheClosedEntry(t *testing.T) {
	if hysteriaBin == "" {
		t.Skip("HYSTERIA_BIN not set")
	}
	blob, err := renderConfig(goldenCfg, goldenInbound, closedHandoff)
	if err != nil {
		t.Fatal(err)
	}
	if up, log := verdict(t, forEngine(t, blob)); !up {
		t.Fatalf("hysteria refused the closed entry:\n%s", log)
	}
}

func TestAnEntryTheAdapterCannotTakeIsClosedAndLiftedByTheNextHandoff(t *testing.T) {
	runner := &recordingRunner{}
	a, cfgPath := newApplyInboundAdapter(t, runner)
	if err := a.ApplyInbound(443, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	bad := handoffJSON(t, &ChainHandoff{Port: 26000, Username: "chain", Password: "pw\nacl:"})
	if err := a.ApplyCascade(bad); err == nil {
		t.Fatal("a refused hand-off must still come back as an error")
	}
	blob, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(blob), "reject(all)") || strings.Contains(string(blob), "type: direct") {
		t.Fatalf("a refused first hand-off is not drawn closed:\n%s", blob)
	}
	if !strings.Contains(a.CascadeClosed(), "YAML") {
		t.Fatalf("closed reason %q does not say why", a.CascadeClosed())
	}
	restarts := len(runner.snapshot())
	_ = a.ApplyCascade(bad)
	if len(runner.snapshot()) != restarts {
		t.Fatal("a repeated refusal restarted the core")
	}

	if err := a.ApplyCascade(handoffJSON(t, goldenHandoff)); err != nil {
		t.Fatal(err)
	}
	blob, _ = os.ReadFile(cfgPath)
	if strings.Contains(string(blob), "reject(all)") || !strings.Contains(string(blob), "addr: 127.0.0.1:26000") || a.CascadeClosed() != "" {
		t.Fatalf("the accepted hand-off did not lift the closing:\n%s", blob)
	}

	// A refusal while one is held keeps the held one.
	if err := a.ApplyCascade(bad); err == nil {
		t.Fatal("refusal not reported")
	}
	blob, _ = os.ReadFile(cfgPath)
	if !strings.Contains(string(blob), "addr: 127.0.0.1:26000") || a.CascadeClosed() != "" {
		t.Fatalf("a refused hand-off replaced the held one:\n%s", blob)
	}

	// Closed by the server, lifted by a real nil.
	if err := a.ApplyCascade(nil); err != nil {
		t.Fatal(err)
	}
	_ = a.CloseCascade("userCore: engines do not match")
	blob, _ = os.ReadFile(cfgPath)
	if !strings.Contains(string(blob), "reject(all)") || !strings.Contains(a.CascadeClosed(), "engines do not match") {
		t.Fatalf("CloseCascade did not close:\n%s", blob)
	}
	if err := a.ApplyCascade(nil); err != nil {
		t.Fatal(err)
	}
	blob, _ = os.ReadFile(cfgPath)
	if strings.Contains(string(blob), "reject(all)") || !strings.Contains(string(blob), "type: direct") {
		t.Fatalf("a real nil must bring back the base render:\n%s", blob)
	}
}

// Before any inbound: remembered closed, and the first render is closed too.
func TestARefusedHandoffBeforeTheInboundDrawsTheFirstRenderClosed(t *testing.T) {
	a, cfgPath := newApplyInboundAdapter(t, &recordingRunner{})
	if err := a.ApplyCascade(json.RawMessage(`{"port":0}`)); err == nil {
		t.Fatal("refusal not reported")
	}
	if err := a.ApplyInbound(443, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(blob), "reject(all)") || strings.Contains(string(blob), "type: direct") {
		t.Fatalf("first render is not closed:\n%s", blob)
	}
}

// The real engine and a real client: the closed entry takes the handshake (the
// client connects and its socks listener answers) and carries nothing; the same
// entry drawn open carries the request (the control).
func TestARealClosedEntryTakesTheHandshakeAndCarriesNothing(t *testing.T) {
	if hysteriaBin == "" {
		t.Skip("HYSTERIA_BIN not set")
	}
	echo := echoServer(t)
	through := func(name string, h *ChainHandoff) (connected bool, err error) {
		dir := t.TempDir()
		cfg := Config{
			ConfigPath:       filepath.Join(dir, "config.yaml"),
			AuthCallbackPort: freeTCP(t),
		}
		certPEM, keyPEM, _ := pemPair(t)
		udp := freeUDP(t)
		in := InboundConfig{Port: udp, TLSCertPEM: certPEM, TLSKeyPEM: keyPEM}
		if err := writeTLSPair(cfg.ConfigPath, certPEM, keyPEM); err != nil {
			t.Fatal(err)
		}
		// The agent's own /auth callback, as the kick test does it.
		a := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
		_ = a.AddUser(core.User{UserID: "u-alice", HysteriaPassword: "pw-alice-not-a-secret"})
		blob, rerr := renderConfig(a.cfg, in, h)
		if rerr != nil {
			t.Fatal(rerr)
		}
		if err := a.Start(t.Context()); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = a.Stop(t.Context()) })
		if err := os.WriteFile(cfg.ConfigPath, blob, 0o600); err != nil {
			t.Fatal(err)
		}
		run(t, dir, name+"-server", "server up and running", hysteriaBin, "server", "-c", cfg.ConfigPath)
		socks := freeTCP(t)
		ccfg := filepath.Join(dir, "client.yaml")
		body := fmt.Sprintf("server: 127.0.0.1:%d\nauth: pw-alice-not-a-secret\ntls:\n  insecure: true\nsocks5:\n  listen: 127.0.0.1:%d\n", udp, socks)
		if err := os.WriteFile(ccfg, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		run(t, dir, name+"-client", "", hysteriaBin, "client", "-c", ccfg)
		var last error
		for deadline := time.Now().Add(8 * time.Second); time.Now().Before(deadline); time.Sleep(250 * time.Millisecond) {
			c, derr := socksDial(socks, echo)
			if derr != nil {
				last = derr
				continue
			}
			connected = true
			last = roundTrip(c)
			c.Close()
			if last == nil {
				return true, nil
			}
		}
		return connected, last
	}
	if _, err := through("open", nil); err != nil {
		t.Fatalf("control: the open entry did not carry the request: %v", err)
	}
	_, err := through("closed", closedHandoff)
	if err == nil {
		t.Fatal("a closed entry carried a request")
	}
}
