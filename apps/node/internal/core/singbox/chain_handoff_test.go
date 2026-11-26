package singbox

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const handoffWire = `{"port":26000,"username":"chain","password":"chain-socks-fixture-password-0000"}`

type renderedChain struct {
	Outbounds []map[string]any `json:"outbounds"`
	Route     map[string]any   `json:"route"`
}

func readRendered(t *testing.T, blob []byte) renderedChain {
	t.Helper()
	var r renderedChain
	if err := json.Unmarshal(blob, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func chainRenderFixture(protocol string) (*Adapter, []heldInbound, map[string]userEntry) {
	a := New(Config{Protocol: protocol}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	held := []heldInbound{{id: "a", cfg: InboundConfig{ListenPort: 1001, ServerName: "n", Method: "2022-blake3-aes-128-gcm", ServerPSK: "AAAAAAAAAAAAAAAAAAAAAA==", ShadowtlsHandshake: "example.com:443"}}}
	return a, held, map[string]userEntry{"alice": {UUID: "u-a", Password: "p"}}
}

// Every protocol of the entry list: the only outbound is the chain's socks on
// loopback with the block's credentials, route.final names it, and there is no
// direct outbound for a connection to fall back to.
func TestAHandoffMakesTheChainTheOnlyWayOut(t *testing.T) {
	for _, proto := range []string{"tuic", "anytls", "shadowtls", "shadowsocks"} {
		a, held, users := chainRenderFixture(proto)
		blob, err := a.renderAllWith("c", "k", "", held, users, &ChainHandoff{Port: 26000, Username: "chain", Password: "pw"})
		if err != nil {
			t.Fatalf("%s: %v", proto, err)
		}
		r := readRendered(t, blob)
		if len(r.Outbounds) != 1 {
			t.Fatalf("%s: outbounds %v, want only the chain", proto, r.Outbounds)
		}
		o := r.Outbounds[0]
		if o["type"] != "socks" || o["tag"] != "chain" || o["server"] != "127.0.0.1" ||
			o["server_port"] != float64(26000) || o["username"] != "chain" || o["password"] != "pw" {
			t.Errorf("%s: chain outbound %v", proto, o)
		}
		if r.Route["final"] != "chain" {
			t.Errorf("%s: route %v, want final=chain", proto, r.Route)
		}
		if strings.Contains(string(blob), `"direct"`) {
			t.Errorf("%s: a direct outbound is drawn next to the chain", proto)
		}
	}
}

// Without a hand-off the render is what it always was: byte for byte.
func TestNoHandoffRendersTheConfigOfTheBase(t *testing.T) {
	for _, proto := range []string{"tuic", "anytls", "shadowtls", "shadowsocks"} {
		a, held, users := chainRenderFixture(proto)
		plain, err := a.renderAll("c", "k", "", held, users)
		if err != nil {
			t.Fatal(err)
		}
		with, err := a.renderAllWith("c", "k", "", held, users, nil)
		if err != nil {
			t.Fatal(err)
		}
		if string(plain) != string(with) {
			t.Errorf("%s: nil hand-off changed the render", proto)
		}
		r := readRendered(t, plain)
		if r.Route != nil || len(r.Outbounds) != 1 || r.Outbounds[0]["type"] != "direct" {
			t.Errorf("%s: base render has route %v outbounds %v", proto, r.Route, r.Outbounds)
		}
	}
}

func TestShadowtlsKeepsItsInnerInboundUnderTheChainRoute(t *testing.T) {
	a, held, users := chainRenderFixture("shadowtls")
	blob, err := a.renderAllWith("c", "k", "", held, users, &ChainHandoff{Port: 26000, Username: "u", Password: "p"})
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Inbounds []map[string]any `json:"inbounds"`
	}
	if err := json.Unmarshal(blob, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Inbounds) != 2 || doc.Inbounds[0]["detour"] != doc.Inbounds[1]["tag"] {
		t.Fatalf("shadowtls inbounds %v: the detour must reach the inner shadowsocks", doc.Inbounds)
	}
}

func TestAHandoffTheRendererWouldRefuseIsNotAccepted(t *testing.T) {
	a, _, _ := chainRenderFixture("tuic")
	for _, bad := range []string{`{"port":0,"username":"u","password":"p"}`, `{"port":26000,"username":"","password":"p"}`, `{"port":26000,"username":"u"}`, `[1]`} {
		if err := a.ApplyCascade(json.RawMessage(bad)); err == nil {
			t.Errorf("%s accepted", bad)
		}
		if a.chain != nil {
			t.Fatalf("%s left a hand-off behind", bad)
		}
	}
}

// A stand-in that passes `check`, counts runs, and stays up.
func chainStubAdapter(t *testing.T, protocol string) (a *Adapter, cfgPath, starts string) {
	t.Helper()
	dir := t.TempDir()
	starts = filepath.Join(dir, "starts")
	bin := filepath.Join(dir, "sing-box-stub")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = version ]; then echo 'sing-box version 1.13.14'; exit 0; fi\n" +
		"if [ \"$1\" = check ]; then exit 0; fi\n" +
		"echo start >> '" + starts + "'\nexec sleep 30\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	cfgPath = filepath.Join(dir, "config.json")
	a = New(Config{Protocol: protocol, BinaryPath: bin, ConfigPath: cfgPath}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	return a, cfgPath, starts
}

func runs(t *testing.T, starts string) int {
	t.Helper()
	b, _ := os.ReadFile(starts)
	return strings.Count(string(b), "start")
}

// Delivery, repeated delivery, removal: the file follows, and only a change
// restarts the core.
func TestTheHandoffIsDrawnOnDeliveryRepeatsAreFreeAndNilBringsBackDirect(t *testing.T) {
	a, cfgPath, starts := chainStubAdapter(t, "anytls")
	// Before the inbound: remembered, nothing runs.
	if err := a.ApplyCascade(json.RawMessage(handoffWire)); err != nil {
		t.Fatal(err)
	}
	if runs(t, starts) != 0 {
		t.Fatal("the core ran before it had an inbound")
	}
	if err := a.ApplyInbound(9443, []byte(startupWire)); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(cfgPath)
	// The first render of the inbound already carries the hand-off: no window
	// with a direct way out.
	if strings.Contains(string(blob), `"direct"`) || readRendered(t, blob).Route["final"] != "chain" {
		t.Fatalf("first render has no hand-off: %s", blob)
	}
	if runs(t, starts) != 1 {
		t.Fatalf("runs %d, want 1", runs(t, starts))
	}

	if err := a.ApplyCascade(json.RawMessage(handoffWire)); err != nil {
		t.Fatal(err)
	}
	if runs(t, starts) != 1 {
		t.Fatalf("a repeated hand-off restarted the core (%d runs)", runs(t, starts))
	}

	if err := a.ApplyCascade(nil); err != nil {
		t.Fatal(err)
	}
	blob, _ = os.ReadFile(cfgPath)
	r := readRendered(t, blob)
	if r.Route != nil || len(r.Outbounds) != 1 || r.Outbounds[0]["type"] != "direct" {
		t.Fatalf("after nil: %s", blob)
	}
	if runs(t, starts) != 2 {
		t.Fatalf("runs %d, want 2", runs(t, starts))
	}
	// nil again: nothing to do.
	if err := a.ApplyCascade(nil); err != nil || runs(t, starts) != 2 {
		t.Fatalf("a repeated nil restarted the core (%d runs, %v)", runs(t, starts), err)
	}
}
