package xray

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

/*
A-277, live, with the real core. The stand, 26.10: a user of a squad the
cascade was switched off for went out through its exit, because the node
policy's rule "this target -> direction SE" sat above the doors with no user.
Now the rule carries the users the door lets through.

Two users on one socks door; a policy rule "port of server A -> the cascade's
way out" for alice only. The way out is a freedom outbound redirected to
server B, so where a request lands says which rule took it, and each server
counts its hits. alice lands on B, bob goes on down the list to direct and
lands on A. Socks emails are the logins; at an xray entry they are the
panel's user ids, which is what the panel puts in the list. Skipped without
XRAY_BIN.
*/
func TestLiveACascadeRuleTakesOnlyTheUsersItsDoorLetsThrough(t *testing.T) {
	bin := os.Getenv("XRAY_BIN")
	if bin == "" {
		t.Skip("XRAY_BIN not set: the core is not asked here")
	}
	var hitsA, hitsB atomic.Int64
	serverA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hitsA.Add(1)
		_, _ = io.WriteString(w, "A")
	}))
	defer serverA.Close()
	serverB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hitsB.Add(1)
		_, _ = io.WriteString(w, "B")
	}))
	defer serverB.Close()
	_, portA, _ := net.SplitHostPort(serverA.Listener.Addr().String())

	socksPort, api := freePort(t), freePort(t)
	dir := t.TempDir()
	a := New(Config{
		ConfigPath: filepath.Join(dir, "config.json"),
		BinaryPath: bin,
		Inbound:    InboundConfig{ApiPort: api, ListenHost: "127.0.0.1"},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	const aliceUUID = "5f0c9a3e-2b7d-4e51-9c8a-1d2e3f4a5b6c"
	const bobUUID = "6a1d0b4f-3c8e-4f62-8d9b-2e3f4a5b6c7d"
	for _, u := range []core.User{
		{UserID: "u-alice", Username: "alice", XrayUUID: aliceUUID},
		{UserID: "u-bob", Username: "bob", XrayUUID: bobUUID},
	} {
		if err := a.AddUser(u); err != nil {
			t.Fatal(err)
		}
	}

	// The cascade's way out, as the entry draws it under a chain, here a
	// freedom sent to B; and a door the way the gate draws one, after which
	// the policy sits.
	fragments, _ := json.Marshal(map[string]any{
		"inbounds": []any{},
		"outbounds": []any{map[string]any{
			"tag": "cascade-link-out-chain-d1", "protocol": "freedom",
			"settings": map[string]any{"redirect": serverB.Listener.Addr().String()},
		}},
		"routingRules": []any{map[string]any{
			"type": "field", "vlessRoute": "1", "user": []string{"alice"}, "outboundTag": "cascade-link-out-chain-d1",
		}},
	})
	if err := a.ApplyCascade(fragments); err != nil {
		t.Fatalf("ApplyCascade: %v", err)
	}
	policy, _ := json.Marshal(map[string]any{"rules": []any{map[string]any{
		"match":  map[string]any{"port": portA},
		"action": map[string]any{"kind": "cascade", "exit": "cascade-link-out-chain-d1", "users": []string{"alice"}},
	}}})
	if err := a.ApplyPolicy(policy); err != nil {
		t.Fatalf("ApplyPolicy: %v", err)
	}
	wire := []byte(`{"inboundId":"cccccccc-3333-4000-8000-000000000003","subprotocol":"socks","security":"none","network":"raw"}`)
	if err := a.ApplyInbound(socksPort, wire); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}

	get := func(user, pass string) string {
		t.Helper()
		var body string
		var err error
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
			if body, err = socksHTTPGet(socksPort, user, pass, serverA.Listener.Addr().String()); err == nil {
				return body
			}
		}
		t.Fatalf("%s through the door: %v", user, err)
		return ""
	}

	if got := get("alice", aliceUUID); got != "B" {
		t.Fatalf("alice, let through by the door, landed on %q, want B (the cascade)", got)
	}
	if got := get("bob", bobUUID); got != "A" {
		t.Fatalf("bob, kept out by the door, landed on %q, want A (direct): the policy took him into the cascade", got)
	}
	if a, b := hitsA.Load(), hitsB.Load(); a != 1 || b != 1 {
		t.Fatalf("hits: A=%d B=%d, want 1 and 1", a, b)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	var cfg struct {
		Routing struct {
			Rules []map[string]any `json:"rules"`
		} `json:"routing"`
	}
	_ = json.Unmarshal(raw, &cfg)
	found := false
	for _, r := range cfg.Routing.Rules {
		if r["port"] == portA && fmt.Sprint(r["user"]) == "[alice]" {
			found = true
		}
	}
	if !found {
		t.Fatal("the policy rule with user [alice] is not in the config the core runs")
	}
}
