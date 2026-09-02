package singbox

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

// Bridge A (2026-09-02): sing-box renders no routing rules of its own, so a
// client on this core egresses straight out of the node - no cascade, no split,
// no egress policy. The bridge hands its traffic to the node's local xray over
// loopback socks, where all three already work.

const bridgePort = 24101

func bridgeUsers() map[string]userEntry {
	return map[string]userEntry{"u1": {UUID: "11111111-1111-1111-1111-111111111111", Password: "p"}}
}

// renderer is one of the config builders, adapted to a single signature so the
// tests below can assert the same thing about every one of them.
type renderer struct {
	name string
	fn   func(inbound InboundConfig) ([]byte, error)
}

// allRenderers is the list every bridge assertion runs over. It is checked
// against the source in TestEveryRendererGoesThroughBuildOutbounds, so a
// renderer added later cannot quietly skip these tests.
func allRenderers() []renderer {
	u := bridgeUsers()
	return []renderer{
		{"renderConfig", func(i InboundConfig) ([]byte, error) {
			return renderConfig("/c.pem", "/k.pem", "", i, u)
		}},
		{"renderAnytlsConfig", func(i InboundConfig) ([]byte, error) {
			return renderAnytlsConfig("/c.pem", "/k.pem", "", i, u)
		}},
		{"renderHysteria2Config", func(i InboundConfig) ([]byte, error) {
			return renderHysteria2Config("/c.pem", "/k.pem", "", i, u)
		}},
		{"renderXrayFamilyConfig", func(i InboundConfig) ([]byte, error) {
			i.Subprotocol = "vless"
			i.RealityDest = "www.bing.com:443"
			i.RealityServerName = "www.bing.com"
			i.RealityPrivateKey = "kEY"
			i.RealityShortIDsCSV = "aabb"
			return renderXrayFamilyConfig("", i, u)
		}},
		{"renderShadowsocksConfig", func(i InboundConfig) ([]byte, error) {
			i.Method = "2022-blake3-aes-128-gcm"
			i.ServerPSK = "c2VydmVyLXBzay0xMjM0NTY3OA=="
			return renderShadowsocksConfig("", i, u)
		}},
		{"renderShadowtlsConfig", func(i InboundConfig) ([]byte, error) {
			i.ShadowtlsHandshake = "www.bing.com:443"
			i.Method = "2022-blake3-aes-128-gcm"
			i.ServerPSK = "c2VydmVyLXBzay0xMjM0NTY3OA=="
			return renderShadowtlsConfig("", i, u)
		}},
	}
}

func decode(t *testing.T, blob []byte) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(blob, &doc); err != nil {
		t.Fatalf("config is not JSON: %v", err)
	}
	return doc
}

// Without a bridge port nothing changes: one `direct` outbound and no route
// section at all. This is the control for every assertion below - if the
// no-bridge shape drifted, the bridge assertions would be measuring nothing.
func TestNoBridgeRendersUnchanged(t *testing.T) {
	for _, r := range allRenderers() {
		t.Run(r.name, func(t *testing.T) {
			blob, err := r.fn(InboundConfig{ListenPort: 2087, ServerName: "www.bing.com"})
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			doc := decode(t, blob)
			if _, ok := doc["route"]; ok {
				t.Fatalf("no bridge configured but a route section was rendered: %s", blob)
			}
			obs, _ := doc["outbounds"].([]any)
			if len(obs) != 1 {
				t.Fatalf("want exactly one outbound without a bridge, got %d: %s", len(obs), blob)
			}
			ob, _ := obs[0].(map[string]any)
			if ob["type"] != "direct" || ob["tag"] != "direct" {
				t.Fatalf("want the plain direct outbound, got %v", ob)
			}
			if _, ok := ob["server"]; ok {
				t.Fatalf("direct outbound must not carry a dial address: %v", ob)
			}
		})
	}
}

// With a bridge port the core must dial the local xray and, crucially, must
// SAY so via route.final. Relying on "the first outbound is the default" is
// what would make a version bump silently route every buyer's traffic out of
// the entry node instead of into the cascade.
func TestBridgeRoutesEveryProtocolToLocalXray(t *testing.T) {
	for _, r := range allRenderers() {
		t.Run(r.name, func(t *testing.T) {
			blob, err := r.fn(InboundConfig{
				ListenPort:      2087,
				ServerName:      "www.bing.com",
				BridgeSocksPort: bridgePort,
			})
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			doc := decode(t, blob)

			route, ok := doc["route"].(map[string]any)
			if !ok {
				t.Fatalf("bridge configured but no route section: %s", blob)
			}
			if route["final"] != bridgeOutboundTag {
				t.Fatalf("route.final = %v, want %q", route["final"], bridgeOutboundTag)
			}

			obs, _ := doc["outbounds"].([]any)
			if len(obs) != 2 {
				t.Fatalf("want bridge + direct, got %d outbounds: %s", len(obs), blob)
			}
			br, _ := obs[0].(map[string]any)
			if br["tag"] != bridgeOutboundTag {
				t.Fatalf("first outbound tag = %v, want %q", br["tag"], bridgeOutboundTag)
			}
			if br["type"] != "socks" {
				t.Fatalf("bridge outbound type = %v, want socks", br["type"])
			}
			if br["server"] != "127.0.0.1" {
				t.Fatalf("bridge dials %v, want loopback only", br["server"])
			}
			if got, want := br["server_port"], float64(bridgePort); got != want {
				t.Fatalf("bridge port = %v, want %v", got, want)
			}
			// SOCKS4 has no UDP ASSOCIATE: every QUIC and DNS flow of a TUIC
			// client would be dropped, and nothing would log it.
			if br["version"] != "5" {
				t.Fatalf("bridge socks version = %v, want \"5\"", br["version"])
			}
			// `direct` stays in the list so clearing the bridge renders
			// byte-identically to a pre-bridge config.
			if d, _ := obs[1].(map[string]any); d["tag"] != directOutboundTag {
				t.Fatalf("second outbound = %v, want the direct outbound", obs[1])
			}
		})
	}
}

// A zero or negative port is "no bridge", not "dial port 0": the panel omits
// the field when it has nowhere to send the traffic, and a config that dialled
// a port nobody listens on would take the whole inbound dark.
func TestBridgePortZeroIsNoBridge(t *testing.T) {
	for _, port := range []int{0, -1} {
		blob, err := renderConfig("/c.pem", "/k.pem", "", InboundConfig{
			ListenPort:      2087,
			BridgeSocksPort: port,
		}, bridgeUsers())
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		if strings.Contains(string(blob), bridgeOutboundTag) {
			t.Fatalf("port %d rendered a bridge: %s", port, blob)
		}
	}
}

// Mirror test. Every renderer in config.go must get its outbounds from
// buildOutbounds, and must be covered by allRenderers() above.
//
// It exists because the repo has been bitten by exactly this: a rule that had
// to hold "for every renderer", written as a literal inside each renderer, and
// five of six got it. It carries its own control - an unreadable source or a
// pattern that matches nothing is a failure, not a pass, which is the other
// trap this file is guarding against (a mirror test that silently finds nothing
// is worse than no test at all).
func TestEveryRendererGoesThroughBuildOutbounds(t *testing.T) {
	src, err := os.ReadFile("config.go")
	if err != nil {
		t.Fatalf("cannot read config.go - this test verifies nothing without it: %v", err)
	}
	text := string(src)

	names := regexp.MustCompile(`(?m)^func (render\w*Config)\(`).FindAllStringSubmatch(text, -1)
	if len(names) < 6 {
		t.Fatalf("found %d renderers in config.go; expected at least the six that exist. "+
			"Either the pattern stopped matching (fix it) or renderers were removed (update this test)", len(names))
	}

	covered := map[string]bool{}
	for _, r := range allRenderers() {
		covered[r.name] = true
	}

	for _, m := range names {
		name := m[1]
		start := strings.Index(text, "func "+name+"(")
		if start < 0 {
			t.Fatalf("cannot locate body of %s", name)
		}
		// The body runs to the next top-level func, or to EOF for the last one.
		end := len(text)
		if next := strings.Index(text[start+1:], "\nfunc "); next >= 0 {
			end = start + 1 + next
		}
		body := text[start:end]
		if !strings.Contains(body, "buildOutbounds(") {
			t.Errorf("%s builds its outbounds itself instead of calling buildOutbounds; "+
				"a bridged client on that protocol would silently egress from this node", name)
		}
		if !covered[name] {
			t.Errorf("%s is not in allRenderers(); the bridge assertions in this file never run against it", name)
		}
	}
}
