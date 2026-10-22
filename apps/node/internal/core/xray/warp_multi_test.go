package xray

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A-033, 22.10: WARP was read off the last inbound of the render loop, so on
// a node with two xray inbounds the WARP of the first was not drawn at all.

func warpOf(key string) *WarpConfig {
	return &WarpConfig{SecretKey: key, Address: []string{"172.16.0.2/32"}}
}

type renderedRouting struct {
	Outbounds []struct {
		Tag      string `json:"tag"`
		Protocol string `json:"protocol"`
	} `json:"outbounds"`
	Routing struct {
		Rules []struct {
			InboundTag  []string `json:"inboundTag"`
			OutboundTag string   `json:"outboundTag"`
		} `json:"rules"`
	} `json:"routing"`
}

func warpRender(t *testing.T, ins []InboundConfig) (renderedRouting, []byte) {
	t.Helper()
	blob, err := renderMultiConfig(ins, nil, nil, 8080, nil, nil)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	var r renderedRouting
	if err := json.Unmarshal(blob, &r); err != nil {
		t.Fatal(err)
	}
	return r, blob
}

func routedTo(r renderedRouting, inboundTag string) string {
	for _, rule := range r.Routing.Rules {
		for _, tag := range rule.InboundTag {
			if tag == inboundTag {
				return rule.OutboundTag
			}
		}
	}
	return ""
}

func twoInbounds() (InboundConfig, InboundConfig) {
	a := validInbound()
	a.Tag, a.ListenPort = "vless-in-aaaaaaaa", 443
	b := validInbound()
	b.Tag, b.ListenPort = "vless-in-bbbbbbbb", 8443
	return a, b
}

func TestWarpOnTheFirstOfTwoInboundsIsDrawn(t *testing.T) {
	a, b := twoInbounds()
	a.Warp = warpOf("aGVsbG8td29ybGQtdGhpcy1pcy1hLWZha2Uta2V5MDA=")
	r, _ := warpRender(t, []InboundConfig{a, b})
	if routedTo(r, a.Tag) != "warp" {
		t.Fatalf("the first inbound's WARP is not drawn: rules %+v", r.Routing.Rules)
	}
	if got := routedTo(r, b.Tag); got != "" {
		t.Fatalf("the second inbound, without WARP, is routed to %q", got)
	}
}

func TestEachInboundGetsItsOwnWarp(t *testing.T) {
	a, b := twoInbounds()
	a.Warp = warpOf("aGVsbG8td29ybGQtdGhpcy1pcy1hLWZha2Uta2V5MDA=")
	b.Warp = warpOf("b3RoZXItd2FycC1rZXktZm9yLXRoZS1zZWNvbmQtMDE=")
	r, _ := warpRender(t, []InboundConfig{a, b})
	ta, tb := routedTo(r, a.Tag), routedTo(r, b.Tag)
	if ta != "warp" || tb == "" || tb == ta {
		t.Fatalf("routes %q and %q, want warp and an outbound of its own", ta, tb)
	}
	// Same credentials share one outbound.
	b.Warp = a.Warp
	r2, _ := warpRender(t, []InboundConfig{a, b})
	if routedTo(r2, a.Tag) != "warp" || routedTo(r2, b.Tag) != "warp" {
		t.Fatalf("same credentials, different outbounds: %+v", r2.Routing.Rules)
	}

	// The core takes the two-WARP config. Skipped without XRAY_BIN.
	bin := os.Getenv("XRAY_BIN")
	if bin == "" {
		t.Skip("XRAY_BIN not set: the core is not asked here")
	}
	priv, _ := x25519Pair(t, bin)
	a.RealityPrivateKey, b.RealityPrivateKey = priv, priv
	b.Warp = warpOf("b3RoZXItd2FycC1rZXktZm9yLXRoZS1zZWNvbmQtMDE=")
	_, blob := warpRender(t, []InboundConfig{a, b})
	path := filepath.Join(t.TempDir(), "config.json")
	_ = os.WriteFile(path, blob, 0o600)
	if out, err := exec.Command(bin, "run", "-test", "-c", path).CombinedOutput(); err != nil {
		t.Fatalf("xray -test refused two WARP outbounds: %v\n%s", err, out)
	}
}
