package xray

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

func validInbound() InboundConfig {
	return InboundConfig{
		RealityDest:        "www.cloudflare.com:443",
		RealityServerNames: []string{"www.cloudflare.com"},
		RealityPrivateKey:  "fake-private-key-for-testing",
		RealityShortIDs:    []string{"abc123"},
	}
}

func TestInboundValidation(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*InboundConfig)
		wantErr string
	}{
		{"missing private key", func(c *InboundConfig) { c.RealityPrivateKey = "" }, "RealityPrivateKey"},
		{"missing server names", func(c *InboundConfig) { c.RealityServerNames = nil }, "RealityServerNames"},
		{"missing short IDs", func(c *InboundConfig) { c.RealityShortIDs = nil }, "RealityShortIDs"},
		{"missing dest", func(c *InboundConfig) { c.RealityDest = "" }, "RealityDest"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := validInbound()
			tc.mutate(&cfg)
			if err := cfg.validate(); err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("validate: got %v, want error containing %q", err, tc.wantErr)
			}
		})
	}
}

func TestInboundDefaults(t *testing.T) {
	cfg := InboundConfig{
		RealityDest:        "x.com:443",
		RealityServerNames: []string{"x.com"},
		RealityPrivateKey:  "k",
		RealityShortIDs:    []string{"s"},
	}
	d := cfg.withDefaults()
	if d.Tag != "vless-in" {
		t.Errorf("Tag default: got %q", d.Tag)
	}
	if d.ListenHost != "0.0.0.0" {
		t.Errorf("ListenHost default: got %q", d.ListenHost)
	}
	if d.ListenPort != 443 {
		t.Errorf("ListenPort default: got %d", d.ListenPort)
	}
	// Flow is no longer defaulted, empty is the canonical "no Vision"
	// value for non-raw transports. Panel sets it explicitly when needed.
	if d.Flow != "" {
		t.Errorf("Flow default: got %q, want empty", d.Flow)
	}
}

func TestRenderConfigShape(t *testing.T) {
	users := []xrayClient{
		{ID: "uuid-1", Email: "user-a"},
		{ID: "uuid-2", Email: "user-b"},
	}
	blob, err := renderConfig(validInbound(), users)
	if err != nil {
		t.Fatalf("renderConfig: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(blob, &parsed); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}

	inbounds, ok := parsed["inbounds"].([]any)
	// Slice 24c: render now emits two inbounds, the public VLESS one and a
	// dedicated `api-in` (dokodemo-door on 127.0.0.1:8080) that exposes
	// StatsService for `xray api statsquery`. Find the VLESS inbound by tag.
	if !ok || len(inbounds) != 2 {
		t.Fatalf("expected 2 inbounds (vless + api-in), got %v", parsed["inbounds"])
	}
	var inb map[string]any
	for _, raw := range inbounds {
		m := raw.(map[string]any)
		if m["protocol"] == "vless" {
			inb = m
			break
		}
	}
	if inb == nil {
		t.Fatalf("vless inbound not found in render output")
	}
	stream := inb["streamSettings"].(map[string]any)
	if stream["network"] != "raw" {
		t.Errorf("network: got %v want raw (v24.9.30 naming)", stream["network"])
	}
	if stream["security"] != "reality" {
		t.Errorf("security: got %v want reality", stream["security"])
	}
	settings := inb["settings"].(map[string]any)
	clients := settings["clients"].([]any)
	if len(clients) != 2 {
		t.Errorf("clients: got %d want 2", len(clients))
	}

	// Slice 24c, verify stats wiring is present
	if _, ok := parsed["stats"]; !ok {
		t.Errorf("stats block missing from rendered config")
	}
	api, ok := parsed["api"].(map[string]any)
	if !ok || api["tag"] != "api" {
		t.Errorf("api block missing/wrong: %v", parsed["api"])
	}
	policy := parsed["policy"].(map[string]any)
	levels := policy["levels"].(map[string]any)
	level0 := levels["0"].(map[string]any)
	if level0["statsUserUplink"] != true || level0["statsUserDownlink"] != true {
		t.Errorf("policy.levels.0 missing per-user stats flags: %v", level0)
	}
}

func TestRenderConfigEmptyClients(t *testing.T) {
	blob, err := renderConfig(validInbound(), []xrayClient{})
	if err != nil {
		t.Fatalf("renderConfig: %v", err)
	}
	if !strings.Contains(string(blob), `"clients": []`) {
		t.Errorf("expected empty clients array in: %s", string(blob))
	}
}

func TestRenderConfigPropagatesValidationError(t *testing.T) {
	bad := validInbound()
	bad.RealityPrivateKey = ""
	if _, err := renderConfig(bad, nil); err == nil {
		t.Errorf("expected validation error to propagate")
	}
}

func TestRenderConfigWarpEgress(t *testing.T) {
	cfg := validInbound()
	cfg.Tag = "vless-in"
	cfg.Warp = &WarpConfig{
		SecretKey: "WARP-PRIV",
		Address:   []string{"172.16.0.2/32", "2606:4700:110::/128"},
		Reserved:  []int{240, 25, 146},
	}
	blob, err := renderConfig(cfg, []xrayClient{{ID: "u", Email: "u"}})
	if err != nil {
		t.Fatalf("renderConfig: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(blob, &parsed); err != nil {
		t.Fatal(err)
	}

	// The WARP wireguard outbound must be present with defaults filled in.
	var warp map[string]any
	for _, raw := range parsed["outbounds"].([]any) {
		m := raw.(map[string]any)
		if m["tag"] == "warp" {
			warp = m
			break
		}
	}
	if warp == nil {
		t.Fatalf("warp outbound not found: %v", parsed["outbounds"])
	}
	if warp["protocol"] != "wireguard" {
		t.Errorf("warp protocol = %v, want wireguard", warp["protocol"])
	}
	s := warp["settings"].(map[string]any)
	if s["secretKey"] != "WARP-PRIV" {
		t.Errorf("secretKey = %v", s["secretKey"])
	}
	if s["mtu"].(float64) != 1280 {
		t.Errorf("mtu = %v, want 1280 (default)", s["mtu"])
	}
	reserved := s["reserved"].([]any)
	if len(reserved) != 3 || reserved[0].(float64) != 240 {
		t.Errorf("reserved = %v, want [240 25 146]", reserved)
	}
	peer := s["peers"].([]any)[0].(map[string]any)
	if peer["publicKey"] != warpDefaultPublicKey {
		t.Errorf("peer publicKey = %v, want default", peer["publicKey"])
	}
	if peer["endpoint"] != warpDefaultEndpoint {
		t.Errorf("peer endpoint = %v, want default", peer["endpoint"])
	}

	// A routing rule must send the user inbound's traffic to the warp outbound.
	rules := parsed["routing"].(map[string]any)["rules"].([]any)
	found := false
	for _, raw := range rules {
		m := raw.(map[string]any)
		if m["outboundTag"] == "warp" {
			tags := m["inboundTag"].([]any)
			if len(tags) == 1 && tags[0] == "vless-in" {
				found = true
			}
		}
	}
	if !found {
		t.Errorf("no routing rule sending vless-in -> warp: %v", rules)
	}

	// Without Warp the config must not mention warp at all (byte-stable).
	plain, _ := renderConfig(validInbound(), nil)
	if strings.Contains(string(plain), `"warp"`) {
		t.Error("non-warp config should not mention warp")
	}
}

func TestWarpValidation(t *testing.T) {
	ok := validInbound()
	ok.Warp = &WarpConfig{SecretKey: "k", Address: []string{"172.16.0.2/32"}}
	if err := ok.validate(); err != nil {
		t.Fatalf("valid warp should pass: %v", err)
	}

	noKey := validInbound()
	noKey.Warp = &WarpConfig{Address: []string{"172.16.0.2/32"}}
	if err := noKey.validate(); err == nil || !strings.Contains(err.Error(), "SecretKey") {
		t.Errorf("missing SecretKey: got %v", err)
	}

	badReserved := validInbound()
	badReserved.Warp = &WarpConfig{SecretKey: "k", Address: []string{"172.16.0.2/32"}, Reserved: []int{1, 2}}
	if err := badReserved.validate(); err == nil || !strings.Contains(err.Error(), "Reserved") {
		t.Errorf("bad reserved length: got %v", err)
	}
}

func TestWriteConfigAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "subdir", "config.json")
	blob := []byte(`{"hello":"world"}`)
	if err := writeConfig(path, blob); err != nil {
		t.Fatalf("writeConfig: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != string(blob) {
		t.Errorf("content mismatch: got %q", string(got))
	}
	// Temp file should be cleaned up after rename.
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("temp file lingered: %v", err)
	}
}

// ───── K9-B: REALITY self-steal ─────

// TestSelfSteal_RewritesDestAndValidates checks that self-steal mode (a) passes
// validation even with an empty/loopback dest the SSRF guard would normally
// reject, and (b) withDefaults rewrites RealityDest to the local fallback, so
// the rendered REALITY config points at 127.0.0.1:8443.
func TestSelfSteal_RewritesDestAndValidates(t *testing.T) {
	cfg := InboundConfig{
		RealityServerNames: []string{"node.example.com"},
		RealityPrivateKey:  "k",
		RealityShortIDs:    []string{"ab"},
		RealityMode:        "self-steal",
		// RealityDest deliberately empty: self-steal supplies it.
	}
	if err := cfg.validate(); err != nil {
		t.Fatalf("self-steal should validate without a panel dest: %v", err)
	}
	d := cfg.withDefaults()
	if d.RealityDest != selfStealAddr {
		t.Errorf("withDefaults should rewrite dest to %s, got %q", selfStealAddr, d.RealityDest)
	}

	blob, err := renderConfig(cfg, []xrayClient{{ID: "u1", Email: "u1"}})
	if err != nil {
		t.Fatalf("renderConfig: %v", err)
	}
	if !strings.Contains(string(blob), selfStealAddr) {
		t.Errorf("rendered config should reference self-steal dest %s", selfStealAddr)
	}
}

// TestStealOthers_StillRejectsLoopbackDest guards the SSRF check for the normal
// mode: a loopback dest WITHOUT self-steal must still be refused.
func TestStealOthers_StillRejectsLoopbackDest(t *testing.T) {
	cfg := InboundConfig{
		RealityServerNames: []string{"x.com"},
		RealityPrivateKey:  "k",
		RealityShortIDs:    []string{"ab"},
		RealityDest:        "127.0.0.1:8443",
		// RealityMode empty == steal-others.
	}
	if err := cfg.validate(); err == nil {
		t.Errorf("loopback dest must be rejected when NOT self-steal (SSRF guard)")
	}
}

// ───── C3: cascade fragment merging ─────

// TestRender_CascadeNil_ByteIdenticalToBase is the safety net for non-cascade
// nodes: passing a nil *CascadeFragments must produce exactly the same bytes as
// the plain renderConfig path, so every existing node is unaffected.
func TestRender_CascadeNil_ByteIdenticalToBase(t *testing.T) {
	users := []xrayClient{{ID: "u1", Email: "u1"}}
	base, err := renderConfig(validInbound(), users)
	if err != nil {
		t.Fatalf("renderConfig: %v", err)
	}
	withNil, err := renderConfigWithCascade(validInbound(), users, nil)
	if err != nil {
		t.Fatalf("renderConfigWithCascade(nil): %v", err)
	}
	if string(base) != string(withNil) {
		t.Errorf("nil cascade must be byte-identical to base render\nbase:\n%s\nwithNil:\n%s", base, withNil)
	}
}

// TestRender_CascadeFragmentsMerged checks that the panel-generated link-in
// inbound, link-out outbound and routing rules are appended to the base config,
// and that base anti-abuse rules still precede the cascade rules.
func TestRender_CascadeFragmentsMerged(t *testing.T) {
	cascade := &CascadeFragments{
		Inbounds: []json.RawMessage{
			json.RawMessage(`{"tag":"cascade-link-in","protocol":"vless","port":24000}`),
		},
		Outbounds: []json.RawMessage{
			json.RawMessage(`{"tag":"cascade-link-out","protocol":"vless"}`),
		},
		RoutingRules: []json.RawMessage{
			json.RawMessage(`{"type":"field","inboundTag":["vless-in"],"outboundTag":"cascade-link-out"}`),
		},
	}
	blob, err := renderConfigWithCascade(validInbound(), []xrayClient{{ID: "u1", Email: "u1"}}, cascade)
	if err != nil {
		t.Fatalf("renderConfigWithCascade: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(blob, &m); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}

	// link-in inbound present (base vless + api-in + cascade = 3)
	inbounds := m["inbounds"].([]any)
	if len(inbounds) != 3 {
		t.Fatalf("expected 3 inbounds (vless + api-in + cascade-link-in), got %d", len(inbounds))
	}
	var sawLinkIn bool
	for _, raw := range inbounds {
		if raw.(map[string]any)["tag"] == "cascade-link-in" {
			sawLinkIn = true
		}
	}
	if !sawLinkIn {
		t.Errorf("cascade-link-in inbound not merged: %v", inbounds)
	}

	// link-out outbound present (base direct/dns-out/blocked + cascade = 4)
	outbounds := m["outbounds"].([]any)
	var sawLinkOut bool
	for _, raw := range outbounds {
		if raw.(map[string]any)["tag"] == "cascade-link-out" {
			sawLinkOut = true
		}
	}
	if !sawLinkOut {
		t.Errorf("cascade-link-out outbound not merged: %v", outbounds)
	}

	// Cascade routing rule present AND positioned after the base block rules so
	// the DNS-hijack / BitTorrent / SMTP rules keep precedence.
	rules := m["routing"].(map[string]any)["rules"].([]any)
	lastIdx, cascadeIdx := -1, -1
	for i, raw := range rules {
		r := raw.(map[string]any)
		if r["outboundTag"] == "blocked" {
			lastIdx = i // remember the last base block rule index
		}
		if r["outboundTag"] == "cascade-link-out" {
			cascadeIdx = i
		}
	}
	if cascadeIdx == -1 {
		t.Fatalf("cascade routing rule not merged: %v", rules)
	}
	if cascadeIdx < lastIdx {
		t.Errorf("cascade rule (idx %d) must come after base block rules (last block idx %d)", cascadeIdx, lastIdx)
	}
}

func renderedDomainStrategy(t *testing.T, cascade *CascadeFragments) string {
	t.Helper()
	blob, err := renderConfigWithCascade(validInbound(), []xrayClient{{ID: "u1", Email: "u1"}}, cascade)
	if err != nil {
		t.Fatalf("renderConfigWithCascade: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(blob, &m); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	return m["routing"].(map[string]any)["domainStrategy"].(string)
}

// E (§3.1): a geo-split entry may override routing.domainStrategy to IPOnDemand
// so its geoip/ip rules resolve ahead of the catch-all. Default stays
// IPIfNonMatch; an unknown value is ignored (falls back to the default).
func TestRender_DomainStrategyOverride(t *testing.T) {
	if got := renderedDomainStrategy(t, nil); got != "IPIfNonMatch" {
		t.Errorf("nil cascade: domainStrategy = %q, want IPIfNonMatch", got)
	}
	if got := renderedDomainStrategy(t, &CascadeFragments{}); got != "IPIfNonMatch" {
		t.Errorf("empty cascade: domainStrategy = %q, want IPIfNonMatch", got)
	}
	if got := renderedDomainStrategy(t, &CascadeFragments{DomainStrategy: "IPOnDemand"}); got != "IPOnDemand" {
		t.Errorf("override: domainStrategy = %q, want IPOnDemand", got)
	}
	// A malformed/hostile wire value must not be injected verbatim.
	if got := renderedDomainStrategy(t, &CascadeFragments{DomainStrategy: "evil; drop"}); got != "IPIfNonMatch" {
		t.Errorf("bad override: domainStrategy = %q, want fallback IPIfNonMatch", got)
	}
}

func TestIsKnownDomainStrategy(t *testing.T) {
	for _, s := range []string{"AsIs", "IPIfNonMatch", "IPOnDemand"} {
		if !isKnownDomainStrategy(s) {
			t.Errorf("isKnownDomainStrategy(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "ipondemand", "UseIP", "IPOnDemand ", "evil"} {
		if isKnownDomainStrategy(s) {
			t.Errorf("isKnownDomainStrategy(%q) = true, want false", s)
		}
	}
}

// TestRender_CascadeAutoBalancer covers the C3-auto path: a latency-balanced
// entry ships a top-level `observatory` plus `routing.balancers`, and its user
// rule targets the balancer via `balancerTag`. All three must land verbatim.
func TestRender_CascadeAutoBalancer(t *testing.T) {
	cascade := &CascadeFragments{
		Outbounds: []json.RawMessage{
			json.RawMessage(`{"tag":"cascade-link-out-0","protocol":"vless"}`),
			json.RawMessage(`{"tag":"cascade-link-out-1","protocol":"vless"}`),
		},
		RoutingRules: []json.RawMessage{
			json.RawMessage(`{"type":"field","network":"tcp,udp","balancerTag":"auto"}`),
		},
		Observatory: json.RawMessage(`{"subjectSelector":["cascade-link-out"],"probeURL":"https://www.gstatic.com/generate_204","probeInterval":"5m"}`),
		Balancers: []json.RawMessage{
			json.RawMessage(`{"tag":"auto","selector":["cascade-link-out"],"strategy":{"type":"leastPing"}}`),
		},
	}
	blob, err := renderConfigWithCascade(validInbound(), []xrayClient{{ID: "u1", Email: "u1"}}, cascade)
	if err != nil {
		t.Fatalf("renderConfigWithCascade: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(blob, &m); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	obs, ok := m["observatory"].(map[string]any)
	if !ok {
		t.Fatalf("observatory missing/not an object: %v", m["observatory"])
	}
	if obs["probeURL"] != "https://www.gstatic.com/generate_204" {
		t.Errorf("observatory probeURL not carried through: %v", obs)
	}
	routing := m["routing"].(map[string]any)
	bals, ok := routing["balancers"].([]any)
	if !ok || len(bals) != 1 {
		t.Fatalf("routing.balancers missing/wrong len: %v", routing["balancers"])
	}
	if bals[0].(map[string]any)["tag"] != "auto" {
		t.Errorf("balancer tag not carried: %v", bals[0])
	}
	var sawBal bool
	for _, raw := range routing["rules"].([]any) {
		if raw.(map[string]any)["balancerTag"] == "auto" {
			sawBal = true
		}
	}
	if !sawBal {
		t.Errorf("balancerTag routing rule not merged: %v", routing["rules"])
	}
}

// TestRender_CascadeNoBalancer_NoKeys: a plain cascade WITHOUT observatory/
// balancers must NOT emit those keys, the balancer path is strictly additive.
func TestRender_CascadeNoBalancer_NoKeys(t *testing.T) {
	cascade := &CascadeFragments{
		Outbounds:    []json.RawMessage{json.RawMessage(`{"tag":"cascade-link-out","protocol":"vless"}`)},
		RoutingRules: []json.RawMessage{json.RawMessage(`{"type":"field","outboundTag":"cascade-link-out"}`)},
	}
	blob, err := renderConfigWithCascade(validInbound(), nil, cascade)
	if err != nil {
		t.Fatalf("renderConfigWithCascade: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(blob, &m); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	if _, ok := m["observatory"]; ok {
		t.Errorf("observatory must be absent when not provided")
	}
	if _, ok := m["routing"].(map[string]any)["balancers"]; ok {
		t.Errorf("routing.balancers must be absent when not provided")
	}
}

// TestCascadeEqual covers the restart-gate helper: nil==nil, nil!=non-nil, and
// byte-equality of the raw fragments.
func TestCascadeEqual(t *testing.T) {
	a := &CascadeFragments{Inbounds: []json.RawMessage{json.RawMessage(`{"tag":"x"}`)}}
	b := &CascadeFragments{Inbounds: []json.RawMessage{json.RawMessage(`{"tag":"x"}`)}}
	c := &CascadeFragments{Inbounds: []json.RawMessage{json.RawMessage(`{"tag":"y"}`)}}
	if !cascadeEqual(nil, nil) {
		t.Errorf("nil == nil should be equal")
	}
	if cascadeEqual(a, nil) || cascadeEqual(nil, a) {
		t.Errorf("nil and non-nil must differ")
	}
	if !cascadeEqual(a, b) {
		t.Errorf("identical fragments should be equal")
	}
	if cascadeEqual(a, c) {
		t.Errorf("different fragments should differ")
	}
}

// TestApplyInboundWire_ParsesCascade verifies the panel-pushed `cascade` field
// round-trips into the adapter's wire DTO.
func TestApplyInboundWire_ParsesCascade(t *testing.T) {
	raw := []byte(`{
		"realityPrivateKey":"k",
		"cascade":{
			"inbounds":[{"tag":"cascade-link-in"}],
			"outbounds":[{"tag":"cascade-link-out"}],
			"routingRules":[{"type":"field","outboundTag":"cascade-link-out"}]
		}
	}`)
	var wire xrayInboundCfgWire
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if wire.Cascade == nil {
		t.Fatalf("cascade not parsed from wire")
	}
	if len(wire.Cascade.Inbounds) != 1 || len(wire.Cascade.Outbounds) != 1 || len(wire.Cascade.RoutingRules) != 1 {
		t.Errorf("cascade fragments not fully parsed: %+v", wire.Cascade)
	}
}

// TestApplyInboundWire_NoCascadeIsNil: a plain node's wire has no `cascade`,
// so the field must stay nil (drives the byte-identical render path).
func TestApplyInboundWire_NoCascadeIsNil(t *testing.T) {
	var wire xrayInboundCfgWire
	if err := json.Unmarshal([]byte(`{"realityPrivateKey":"k"}`), &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if wire.Cascade != nil {
		t.Errorf("expected nil cascade when absent from wire, got %+v", wire.Cascade)
	}
}

// ───── Slice 24c part 2: routing defaults + sockopt + transport branches ─────

func renderToMap(t *testing.T, cfg InboundConfig) map[string]any {
	t.Helper()
	blob, err := renderConfig(cfg, []xrayClient{{ID: "u1", Email: "u1"}})
	if err != nil {
		t.Fatalf("renderConfig: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(blob, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return m
}

func TestRender_RoutingDefaults_SniffingOnVlessInbound(t *testing.T) {
	m := renderToMap(t, validInbound())
	inbounds := m["inbounds"].([]any)
	for _, raw := range inbounds {
		inb := raw.(map[string]any)
		if inb["protocol"] == "vless" {
			sn := inb["sniffing"].(map[string]any)
			if sn["enabled"] != true {
				t.Errorf("sniffing should be enabled on vless inbound")
			}
			dest := sn["destOverride"].([]any)
			if len(dest) != 3 {
				t.Errorf("destOverride should have 3 entries, got %v", dest)
			}
		}
	}
}

func TestRender_RoutingDefaults_DnsOutAndBlackhole(t *testing.T) {
	m := renderToMap(t, validInbound())
	outbounds := m["outbounds"].([]any)
	tags := map[string]bool{}
	for _, raw := range outbounds {
		ob := raw.(map[string]any)
		tags[ob["tag"].(string)] = true
	}
	if !tags["direct"] || !tags["dns-out"] || !tags["blocked"] {
		t.Errorf("expected tags direct/dns-out/blocked, got %v", tags)
	}
}

func TestRender_RoutingDefaults_BlockRules(t *testing.T) {
	m := renderToMap(t, validInbound())
	routing := m["routing"].(map[string]any)
	rules := routing["rules"].([]any)

	var dnsRule, btRule, smtpRule bool
	for _, raw := range rules {
		r := raw.(map[string]any)
		out := r["outboundTag"]
		if protocols, ok := r["protocol"].([]any); ok {
			for _, p := range protocols {
				if p == "dns" && out == "dns-out" {
					dnsRule = true
				}
				if p == "bittorrent" && out == "blocked" {
					btRule = true
				}
			}
		}
		if r["port"] == "25" && out == "blocked" {
			smtpRule = true
		}
	}
	if !dnsRule {
		t.Errorf("missing dns→dns-out routing rule")
	}
	if !btRule {
		t.Errorf("missing bittorrent→blocked routing rule")
	}
	if !smtpRule {
		t.Errorf("missing port:25→blocked routing rule")
	}
}

// realitySettingsOf returns the realitySettings of the rendered vless inbound.
func realitySettingsOf(t *testing.T, m map[string]any) map[string]any {
	t.Helper()
	for _, raw := range m["inbounds"].([]any) {
		inb := raw.(map[string]any)
		if inb["protocol"] != "vless" {
			continue
		}
		ss := inb["streamSettings"].(map[string]any)
		return ss["realitySettings"].(map[string]any)
	}
	t.Fatalf("no vless inbound in render")
	return nil
}

// vlessSettingsOf returns the settings (clients/decryption) of the vless inbound.
func vlessSettingsOf(t *testing.T, m map[string]any) map[string]any {
	t.Helper()
	for _, raw := range m["inbounds"].([]any) {
		inb := raw.(map[string]any)
		if inb["protocol"] == "vless" {
			return inb["settings"].(map[string]any)
		}
	}
	t.Fatalf("no vless inbound in render")
	return nil
}

func TestRender_PQ_DefaultOmitsPQFields(t *testing.T) {
	m := renderToMap(t, validInbound())
	if _, ok := realitySettingsOf(t, m)["mldsa65Seed"]; ok {
		t.Errorf("default render must NOT emit realitySettings.mldsa65Seed")
	}
	if got := vlessSettingsOf(t, m)["decryption"]; got != "none" {
		t.Errorf("default VLESS decryption: got %v want \"none\"", got)
	}
}

func TestRender_PQ_Mldsa65SeedEmittedWhenSet(t *testing.T) {
	cfg := validInbound()
	cfg.RealityMldsa65Seed = "seed_AbC-123_xyz"
	if got := realitySettingsOf(t, renderToMap(t, cfg))["mldsa65Seed"]; got != "seed_AbC-123_xyz" {
		t.Errorf("mldsa65Seed: got %v want seed_AbC-123_xyz", got)
	}
}

func TestRender_PQ_VlessDecryptionEmittedWhenSet(t *testing.T) {
	cfg := validInbound()
	cfg.VlessDecryption = "mlkem768x25519plus.native.600s.0-0-0.0-0-0.0-0-0.abcDEF_-"
	got := vlessSettingsOf(t, renderToMap(t, cfg))["decryption"]
	if got != "mlkem768x25519plus.native.600s.0-0-0.0-0-0.0-0-0.abcDEF_-" {
		t.Errorf("VLESS decryption not set from VlessDecryption, got %v", got)
	}
}

func TestRender_PQ_EmptyIsByteIdentical(t *testing.T) {
	users := []xrayClient{{ID: "u1", Email: "u1"}}
	base, err := renderConfig(validInbound(), users)
	if err != nil {
		t.Fatalf("base: %v", err)
	}
	pq := validInbound()
	pq.RealityMldsa65Seed = "" // explicitly empty
	pq.VlessDecryption = ""
	got, err := renderConfig(pq, users)
	if err != nil {
		t.Fatalf("pq: %v", err)
	}
	if !bytes.Equal(base, got) {
		t.Errorf("empty PQ fields must render byte-identically to the default")
	}
}

func TestInboundEqual_PQFields(t *testing.T) {
	t.Run("mldsa65Seed change", func(t *testing.T) {
		a, b := validInbound(), validInbound()
		b.RealityMldsa65Seed = "seed"
		if inboundEqual(a, b) {
			t.Errorf("mldsa65Seed change must make inbounds unequal")
		}
	})
	t.Run("vlessDecryption change", func(t *testing.T) {
		a, b := validInbound(), validInbound()
		b.VlessDecryption = "mlkem768x25519plus.native"
		if inboundEqual(a, b) {
			t.Errorf("vlessDecryption change must make inbounds unequal")
		}
	})
}

// classifyRules returns which of the three U4-gated routing rules are present,
// plus the total rule count (api-in is always present).
func classifyRules(t *testing.T, rules []any) (dns, bt, smtp bool, count int) {
	t.Helper()
	count = len(rules)
	for _, raw := range rules {
		r := raw.(map[string]any)
		out := r["outboundTag"]
		if protocols, ok := r["protocol"].([]any); ok {
			for _, p := range protocols {
				if p == "dns" && out == "dns-out" {
					dns = true
				}
				if p == "bittorrent" && out == "blocked" {
					bt = true
				}
			}
		}
		if r["port"] == "25" && out == "blocked" {
			smtp = true
		}
	}
	return
}

func TestRender_AbusePolicy(t *testing.T) {
	rulesFor := func(t *testing.T, ap *core.AbusePolicy) []any {
		t.Helper()
		cfg := validInbound()
		cfg.AbusePolicy = ap
		m := renderToMap(t, cfg)
		return m["routing"].(map[string]any)["rules"].([]any)
	}

	t.Run("nil policy keeps all rules (default)", func(t *testing.T) {
		dns, bt, smtp, count := classifyRules(t, rulesFor(t, nil))
		if !dns || !bt || !smtp {
			t.Errorf("nil policy: want all rules, got dns=%v bt=%v smtp=%v", dns, bt, smtp)
		}
		if count != 4 { // api-in + dns + bittorrent + smtp
			t.Errorf("nil policy: want 4 rules, got %d", count)
		}
	})

	t.Run("blockTorrent=false drops only the bittorrent rule", func(t *testing.T) {
		dns, bt, smtp, count := classifyRules(t, rulesFor(t,
			&core.AbusePolicy{BlockTorrent: false, BlockSmtp: true, BlockDnsHijack: true}))
		if bt {
			t.Errorf("blockTorrent=false: bittorrent rule should be absent")
		}
		if !dns || !smtp {
			t.Errorf("blockTorrent=false: dns/smtp should remain, got dns=%v smtp=%v", dns, smtp)
		}
		if count != 3 {
			t.Errorf("blockTorrent=false: want 3 rules, got %d", count)
		}
	})

	t.Run("blockDnsHijack=false drops only the dns rule", func(t *testing.T) {
		dns, bt, smtp, count := classifyRules(t, rulesFor(t,
			&core.AbusePolicy{BlockTorrent: true, BlockSmtp: true, BlockDnsHijack: false}))
		if dns {
			t.Errorf("blockDnsHijack=false: dns rule should be absent")
		}
		if !bt || !smtp {
			t.Errorf("blockDnsHijack=false: bt/smtp should remain, got bt=%v smtp=%v", bt, smtp)
		}
		if count != 3 {
			t.Errorf("blockDnsHijack=false: want 3 rules, got %d", count)
		}
	})

	t.Run("all false leaves only the api-in loopback rule", func(t *testing.T) {
		rules := rulesFor(t, &core.AbusePolicy{})
		dns, bt, smtp, count := classifyRules(t, rules)
		if dns || bt || smtp {
			t.Errorf("all-false: no block/dns rules expected, got dns=%v bt=%v smtp=%v", dns, bt, smtp)
		}
		if count != 1 {
			t.Fatalf("all-false: want 1 rule (api-in), got %d", count)
		}
		first := rules[0].(map[string]any)
		if first["outboundTag"] != "api" {
			t.Errorf("all-false: surviving rule should be api-in, got %v", first)
		}
	})

	t.Run("explicit all-true is byte-identical to nil (default)", func(t *testing.T) {
		users := []xrayClient{{ID: "u1", Email: "u1"}}
		nilBlob, err := renderConfig(validInbound(), users)
		if err != nil {
			t.Fatalf("render nil: %v", err)
		}
		allTrue := validInbound()
		allTrue.AbusePolicy = &core.AbusePolicy{BlockTorrent: true, BlockSmtp: true, BlockDnsHijack: true}
		allTrueBlob, err := renderConfig(allTrue, users)
		if err != nil {
			t.Fatalf("render all-true: %v", err)
		}
		if !bytes.Equal(nilBlob, allTrueBlob) {
			t.Errorf("explicit all-true policy must render byte-identically to nil (default)")
		}
	})
}

func TestInboundEqual_AbusePolicy(t *testing.T) {
	policy := func(bt, bs, bd bool) *core.AbusePolicy {
		return &core.AbusePolicy{BlockTorrent: bt, BlockSmtp: bs, BlockDnsHijack: bd}
	}
	cases := []struct {
		name string
		a, b *core.AbusePolicy
		want bool
	}{
		{"both nil", nil, nil, true},
		{"nil vs set", nil, policy(true, true, true), false},
		{"set vs nil", policy(true, true, true), nil, false},
		{"equal", policy(true, false, true), policy(true, false, true), true},
		{"differ", policy(true, false, true), policy(false, false, true), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a, b := validInbound(), validInbound()
			a.AbusePolicy, b.AbusePolicy = tc.a, tc.b
			if got := inboundEqual(a, b); got != tc.want {
				t.Errorf("inboundEqual abusePolicy %s: got %v want %v", tc.name, got, tc.want)
			}
		})
	}
}

func TestRender_DirectOutboundUsesBBR(t *testing.T) {
	m := renderToMap(t, validInbound())
	outbounds := m["outbounds"].([]any)
	for _, raw := range outbounds {
		ob := raw.(map[string]any)
		if ob["tag"] == "direct" {
			ss, ok := ob["streamSettings"].(map[string]any)
			if !ok {
				t.Errorf("direct outbound missing streamSettings")
				return
			}
			sock := ss["sockopt"].(map[string]any)
			if sock["tcpCongestion"] != "bbr" {
				t.Errorf("direct outbound should set tcpCongestion=bbr, got %v", sock["tcpCongestion"])
			}
			if sock["tcpFastOpen"] != true {
				t.Errorf("direct outbound should set tcpFastOpen=true")
			}
		}
	}
}

func TestRender_Network_WSEmitsWsSettings(t *testing.T) {
	cfg := validInbound()
	cfg.Network = "ws"
	cfg.Path = "/vless"
	cfg.HostHeader = "cdn.example.com"
	m := renderToMap(t, cfg)
	for _, raw := range m["inbounds"].([]any) {
		inb := raw.(map[string]any)
		if inb["protocol"] != "vless" {
			continue
		}
		ss := inb["streamSettings"].(map[string]any)
		if ss["network"] != "ws" {
			t.Errorf("network: got %v want ws", ss["network"])
		}
		ws, ok := ss["wsSettings"].(map[string]any)
		if !ok {
			t.Fatalf("wsSettings missing")
		}
		if ws["path"] != "/vless" {
			t.Errorf("ws path: got %v want /vless", ws["path"])
		}
		headers := ws["headers"].(map[string]any)
		if headers["Host"] != "cdn.example.com" {
			t.Errorf("ws Host header: got %v", headers["Host"])
		}
	}
}

func TestRender_Network_HTTPUpgradeEmitsHttpupgradeSettings(t *testing.T) {
	cfg := validInbound()
	cfg.Network = "httpupgrade"
	cfg.Path = "/u"
	m := renderToMap(t, cfg)
	for _, raw := range m["inbounds"].([]any) {
		inb := raw.(map[string]any)
		if inb["protocol"] != "vless" {
			continue
		}
		ss := inb["streamSettings"].(map[string]any)
		if ss["network"] != "httpupgrade" {
			t.Errorf("network: got %v", ss["network"])
		}
		hu, ok := ss["httpupgradeSettings"].(map[string]any)
		if !ok {
			t.Fatalf("httpupgradeSettings missing")
		}
		if hu["path"] != "/u" {
			t.Errorf("httpupgrade path: got %v", hu["path"])
		}
	}
}

func TestRender_Network_KCPEmitsKcpSettings(t *testing.T) {
	cfg := validInbound()
	cfg.Network = "kcp"
	m := renderToMap(t, cfg)
	for _, raw := range m["inbounds"].([]any) {
		inb := raw.(map[string]any)
		if inb["protocol"] != "vless" {
			continue
		}
		ss := inb["streamSettings"].(map[string]any)
		if ss["network"] != "kcp" {
			t.Errorf("network: got %v", ss["network"])
		}
		if _, ok := ss["kcpSettings"].(map[string]any); !ok {
			t.Errorf("kcpSettings missing")
		}
	}
}

func TestRender_Network_GrpcEmitsServiceName(t *testing.T) {
	cfg := validInbound()
	cfg.Network = "grpc"
	cfg.ServiceName = "GunSvc"
	m := renderToMap(t, cfg)
	for _, raw := range m["inbounds"].([]any) {
		inb := raw.(map[string]any)
		if inb["protocol"] != "vless" {
			continue
		}
		ss := inb["streamSettings"].(map[string]any)
		grpc := ss["grpcSettings"].(map[string]any)
		if grpc["serviceName"] != "GunSvc" {
			t.Errorf("serviceName: got %v", grpc["serviceName"])
		}
	}
}

// ───── B3: extra xray options (xver / maxTimeDiff / rejectUnknownSni /
// xhttp mode+padding / grpc multiMode) ─────

// vlessStream pulls the streamSettings of the public vless inbound out of a
// rendered config, so the B3 tests can assert on the transport-level shape.
func vlessStream(t *testing.T, m map[string]any) map[string]any {
	t.Helper()
	for _, raw := range m["inbounds"].([]any) {
		inb := raw.(map[string]any)
		if inb["protocol"] == "vless" {
			return inb["streamSettings"].(map[string]any)
		}
	}
	t.Fatalf("vless inbound not found in render output")
	return nil
}

func TestRender_B3_GrpcMultiMode(t *testing.T) {
	cfg := validInbound()
	cfg.Network = "grpc"
	cfg.ServiceName = "GunSvc"
	cfg.GrpcMultiMode = true
	grpc := vlessStream(t, renderToMap(t, cfg))["grpcSettings"].(map[string]any)
	if grpc["multiMode"] != true {
		t.Errorf("grpcSettings.multiMode: got %v want true", grpc["multiMode"])
	}
}

func TestRender_B3_XhttpMode(t *testing.T) {
	cfg := validInbound()
	cfg.Network = "xhttp"
	cfg.XhttpMode = "packet-up"
	cfg.XhttpPaddingBytes = "100-1000"
	xh := vlessStream(t, renderToMap(t, cfg))["xhttpSettings"].(map[string]any)
	if xh["mode"] != "packet-up" {
		t.Errorf("xhttpSettings.mode: got %v want packet-up", xh["mode"])
	}
	extra, ok := xh["extra"].(map[string]any)
	if !ok {
		t.Fatalf("xhttpSettings.extra missing: %v", xh)
	}
	if extra["xPaddingBytes"] != "100-1000" {
		t.Errorf("xhttp xPaddingBytes: got %v want 100-1000", extra["xPaddingBytes"])
	}
}

func TestRender_B3_XhttpDefaultsToAutoNoPadding(t *testing.T) {
	cfg := validInbound()
	cfg.Network = "xhttp"
	// XhttpMode / XhttpPaddingBytes left empty, must render as before B3.
	xh := vlessStream(t, renderToMap(t, cfg))["xhttpSettings"].(map[string]any)
	if xh["mode"] != "auto" {
		t.Errorf("xhttp default mode: got %v want auto", xh["mode"])
	}
	if _, has := xh["extra"]; has {
		t.Errorf("xhttp should omit extra when no padding set: %v", xh)
	}
}

func TestRender_B3_TlsRejectUnknownSni(t *testing.T) {
	cfg := validInbound()
	cfg.Security = "tls"
	cfg.TLSServerName = "node.example.com"
	cfg.TLSCert = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----"
	cfg.TLSKey = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----"
	cfg.TLSRejectUnknownSni = true
	tls := vlessStream(t, renderToMap(t, cfg))["tlsSettings"].(map[string]any)
	if tls["rejectUnknownSni"] != true {
		t.Errorf("tlsSettings.rejectUnknownSni: got %v want true", tls["rejectUnknownSni"])
	}
}

func TestRender_B3_RealityXverAndMaxTimeDiff(t *testing.T) {
	cfg := validInbound()
	cfg.RealityXver = 2
	cfg.RealityMaxTimeDiff = 60000
	rs := vlessStream(t, renderToMap(t, cfg))["realitySettings"].(map[string]any)
	// JSON numbers decode to float64.
	if rs["xver"] != float64(2) {
		t.Errorf("realitySettings.xver: got %v want 2", rs["xver"])
	}
	if rs["maxTimeDiff"] != float64(60000) {
		t.Errorf("realitySettings.maxTimeDiff: got %v want 60000", rs["maxTimeDiff"])
	}
}

// TestRender_B3_DefaultsBackwardCompatible pins the no-op render: default xver
// 0, no maxTimeDiff, mode auto, multiMode false must match the pre-B3 output so
// existing nodes are byte-stable across the upgrade.
func TestRender_B3_DefaultsBackwardCompatible(t *testing.T) {
	rs := vlessStream(t, renderToMap(t, validInbound()))["realitySettings"].(map[string]any)
	if rs["xver"] != float64(0) {
		t.Errorf("default realitySettings.xver: got %v want 0", rs["xver"])
	}
	if _, has := rs["maxTimeDiff"]; has {
		t.Errorf("default render should omit maxTimeDiff: %v", rs)
	}

	cfg := validInbound()
	cfg.Network = "grpc"
	cfg.ServiceName = "GunSvc"
	grpc := vlessStream(t, renderToMap(t, cfg))["grpcSettings"].(map[string]any)
	if grpc["multiMode"] != false {
		t.Errorf("default grpcSettings.multiMode: got %v want false", grpc["multiMode"])
	}
}

// ───── G: probe-resistance fallback rate-limit ─────

// TestRender_G_RealityLimitFallback pins the throttle render: a non-zero
// upload/download rate emits limitFallbackUpload/Download as REALITY objects
// {afterBytes, bytesPerSec, burstBytesPerSec} on the unverified fallback path.
func TestRender_G_RealityLimitFallback(t *testing.T) {
	cfg := validInbound()
	cfg.RealityLimitFallbackUploadBytesPerSec = 1048576
	cfg.RealityLimitFallbackDownloadBytesPerSec = 2097152
	rs := vlessStream(t, renderToMap(t, cfg))["realitySettings"].(map[string]any)

	up, ok := rs["limitFallbackUpload"].(map[string]any)
	if !ok {
		t.Fatalf("realitySettings.limitFallbackUpload missing: %v", rs)
	}
	// JSON numbers decode to float64.
	if up["bytesPerSec"] != float64(1048576) {
		t.Errorf("limitFallbackUpload.bytesPerSec: got %v want 1048576", up["bytesPerSec"])
	}
	if up["burstBytesPerSec"] != float64(1048576) {
		t.Errorf("limitFallbackUpload.burstBytesPerSec: got %v want 1048576", up["burstBytesPerSec"])
	}
	if up["afterBytes"] != float64(0) {
		t.Errorf("limitFallbackUpload.afterBytes: got %v want 0", up["afterBytes"])
	}

	down, ok := rs["limitFallbackDownload"].(map[string]any)
	if !ok {
		t.Fatalf("realitySettings.limitFallbackDownload missing: %v", rs)
	}
	if down["bytesPerSec"] != float64(2097152) {
		t.Errorf("limitFallbackDownload.bytesPerSec: got %v want 2097152", down["bytesPerSec"])
	}
}

// TestRender_G_DefaultsOmitLimitFallback pins the no-op render: with both rates
// 0 (default) neither limitFallbackUpload nor limitFallbackDownload is emitted,
// so existing nodes stay byte-stable across the upgrade.
func TestRender_G_DefaultsOmitLimitFallback(t *testing.T) {
	rs := vlessStream(t, renderToMap(t, validInbound()))["realitySettings"].(map[string]any)
	if _, has := rs["limitFallbackUpload"]; has {
		t.Errorf("default render should omit limitFallbackUpload: %v", rs)
	}
	if _, has := rs["limitFallbackDownload"]; has {
		t.Errorf("default render should omit limitFallbackDownload: %v", rs)
	}
}

// ───── Slice 24c part 3: Trojan subprotocol ─────

func TestRender_DefaultsToVless(t *testing.T) {
	m := renderToMap(t, validInbound())
	for _, raw := range m["inbounds"].([]any) {
		inb := raw.(map[string]any)
		if inb["tag"] == "vless-in" || inb["tag"] == "" {
			if inb["protocol"] != "vless" {
				t.Errorf("default subprotocol should be vless, got %v", inb["protocol"])
			}
		}
	}
}

func TestRender_TrojanInboundProtocol(t *testing.T) {
	cfg := validInbound()
	cfg.Subprotocol = "trojan"
	m := renderToMap(t, cfg)

	var trojanInb map[string]any
	for _, raw := range m["inbounds"].([]any) {
		inb := raw.(map[string]any)
		if inb["protocol"] == "trojan" {
			trojanInb = inb
			break
		}
	}
	if trojanInb == nil {
		t.Fatalf("trojan inbound not found in render")
	}

	settings := trojanInb["settings"].(map[string]any)
	clients := settings["clients"].([]any)
	if len(clients) != 1 {
		t.Fatalf("expected 1 client, got %d", len(clients))
	}
	c := clients[0].(map[string]any)
	if c["password"] != "u1" {
		t.Errorf("trojan client should have password=ID, got %v", c["password"])
	}
	if _, hasID := c["id"]; hasID {
		t.Errorf("trojan client should NOT have `id` field, only `password`")
	}
	// Trojan also doesn't carry the VLESS-only `decryption: none`
	if _, hasDec := settings["decryption"]; hasDec {
		t.Errorf("trojan settings should NOT have `decryption` field")
	}
}

func TestRender_Trojan_StillUsesRealityStreamSettings(t *testing.T) {
	cfg := validInbound()
	cfg.Subprotocol = "trojan"
	m := renderToMap(t, cfg)
	for _, raw := range m["inbounds"].([]any) {
		inb := raw.(map[string]any)
		if inb["protocol"] != "trojan" {
			continue
		}
		ss := inb["streamSettings"].(map[string]any)
		if ss["security"] != "reality" {
			t.Errorf("trojan should still use REALITY security, got %v", ss["security"])
		}
		// Reality settings should contain server names + private key
		rs := ss["realitySettings"].(map[string]any)
		if rs["privateKey"] != "fake-private-key-for-testing" {
			t.Errorf("trojan should preserve REALITY private key")
		}
	}
}

// B1: the compiled egress policy. A node that was never given one has to render
// exactly what it rendered before the field existed.
func TestRender_RoutingFragments_EmptyIsByteIdentical(t *testing.T) {
	users := []xrayClient{{ID: "u1", Email: "u1"}}
	nilBlob, err := renderConfig(validInbound(), users)
	if err != nil {
		t.Fatalf("render nil: %v", err)
	}
	empty := validInbound()
	empty.RoutingFragments = &RoutingFragments{} // no rules, no outbounds
	emptyBlob, err := renderConfig(empty, users)
	if err != nil {
		t.Fatalf("render empty: %v", err)
	}
	if !bytes.Equal(nilBlob, emptyBlob) {
		t.Errorf("empty RoutingFragments must render byte-identically to nil (default routing)")
	}
}

func TestRender_RoutingFragments_RulesAndOutbounds(t *testing.T) {
	cfg := validInbound()
	cfg.RoutingFragments = &RoutingFragments{
		Rules: []RoutingRule{
			{Domain: []string{"geosite:youtube"}, OutboundTag: "direct"},
			{IP: []string{"geoip:ru"}, Network: "tcp", OutboundTag: "blocked"},
		},
		Outbounds: []json.RawMessage{
			json.RawMessage(`{"tag":"ssz","protocol":"socks","settings":{}}`),
		},
	}
	m := renderToMap(t, cfg)
	rules := m["routing"].(map[string]any)["rules"].([]any)

	var foundYT, foundRU bool
	for _, raw := range rules {
		r := raw.(map[string]any)
		if r["outboundTag"] == "direct" {
			if doms, ok := r["domain"].([]any); ok {
				for _, d := range doms {
					if d == "geosite:youtube" {
						foundYT = true
					}
				}
			}
		}
		if r["outboundTag"] == "blocked" {
			if ips, ok := r["ip"].([]any); ok {
				for _, ip := range ips {
					if ip == "geoip:ru" {
						foundRU = true
					}
				}
			}
		}
	}
	if !foundYT {
		t.Errorf("missing geosite:youtube -> direct routing rule")
	}
	if !foundRU {
		t.Errorf("missing geoip:ru -> blocked routing rule")
	}

	var foundOb bool
	for _, raw := range m["outbounds"].([]any) {
		if raw.(map[string]any)["tag"] == "ssz" {
			foundOb = true
		}
	}
	if !foundOb {
		t.Errorf("custom outbound 'ssz' not appended")
	}
}

// The whole composition contract in one test: the U4 blocks win over the
// policy, and the policy wins over WARP (which is what unmatched traffic falls
// through to). Both directions matter, so both are asserted on one render.
func TestRender_RoutingFragments_OrderBetweenBlocksAndWarp(t *testing.T) {
	cfg := validInbound()
	cfg.Warp = &WarpConfig{SecretKey: "sk", Address: []string{"172.16.0.2/32"}}
	cfg.RoutingFragments = &RoutingFragments{
		Rules: []RoutingRule{{Domain: []string{"geosite:youtube"}, OutboundTag: "direct"}},
	}
	rules := renderToMap(t, cfg)["routing"].(map[string]any)["rules"].([]any)

	btIdx, policyIdx, warpIdx := -1, -1, -1
	for i, raw := range rules {
		r := raw.(map[string]any)
		if protocols, ok := r["protocol"].([]any); ok {
			for _, p := range protocols {
				if p == "bittorrent" {
					btIdx = i
				}
			}
		}
		if r["outboundTag"] == "direct" {
			if doms, ok := r["domain"].([]any); ok {
				for _, d := range doms {
					if d == "geosite:youtube" {
						policyIdx = i
					}
				}
			}
		}
		if r["outboundTag"] == "warp" {
			warpIdx = i
		}
	}
	if btIdx == -1 || policyIdx == -1 || warpIdx == -1 {
		t.Fatalf("expected block, policy and warp rules, got bt=%d policy=%d warp=%d", btIdx, policyIdx, warpIdx)
	}
	if policyIdx < btIdx {
		t.Errorf("policy rule (idx %d) must come AFTER the block rules (idx %d)", policyIdx, btIdx)
	}
	if warpIdx < policyIdx {
		t.Errorf("WARP catch-all (idx %d) must come AFTER the policy rules (idx %d), or the policy never fires", warpIdx, policyIdx)
	}
}

// A geoip rule on a node with a later catch-all only fires if xray is allowed
// to resolve the sniffed domain, which is what the panel sets DomainStrategy
// for. The node applies whatever the panel decided; it does not re-derive it.
func TestRender_RoutingFragments_DomainStrategy(t *testing.T) {
	t.Run("default when unset", func(t *testing.T) {
		cfg := validInbound()
		cfg.RoutingFragments = &RoutingFragments{
			Rules: []RoutingRule{{Domain: []string{"geosite:youtube"}, OutboundTag: "direct"}},
		}
		got := renderToMap(t, cfg)["routing"].(map[string]any)["domainStrategy"]
		if got != "IPIfNonMatch" {
			t.Errorf("domainStrategy = %v, want IPIfNonMatch when the policy does not ask for another", got)
		}
	})

	t.Run("panel override applied", func(t *testing.T) {
		cfg := validInbound()
		cfg.RoutingFragments = &RoutingFragments{
			Rules:          []RoutingRule{{IP: []string{"geoip:ru"}, OutboundTag: "direct"}},
			DomainStrategy: "IPOnDemand",
		}
		got := renderToMap(t, cfg)["routing"].(map[string]any)["domainStrategy"]
		if got != "IPOnDemand" {
			t.Errorf("domainStrategy = %v, want IPOnDemand", got)
		}
	})
}

func TestInboundEqual_RoutingFragments(t *testing.T) {
	rf := func(tag string) *RoutingFragments {
		return &RoutingFragments{Rules: []RoutingRule{{Domain: []string{"geosite:youtube"}, OutboundTag: tag}}}
	}
	strategy := func(s string) *RoutingFragments {
		out := rf("direct")
		out.DomainStrategy = s
		return out
	}
	cases := []struct {
		name string
		a, b *RoutingFragments
		want bool
	}{
		{"both nil", nil, nil, true},
		{"nil vs set", nil, rf("direct"), false},
		{"equal", rf("direct"), rf("direct"), true},
		{"differ tag", rf("direct"), rf("blocked"), false},
		{"differ domainStrategy", rf("direct"), strategy("IPOnDemand"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a, b := validInbound(), validInbound()
			a.RoutingFragments, b.RoutingFragments = tc.a, tc.b
			if got := inboundEqual(a, b); got != tc.want {
				t.Errorf("inboundEqual routingFragments %s: got %v want %v", tc.name, got, tc.want)
			}
		})
	}
}

// One config has ONE routing.domainStrategy, and two independent features ask
// to raise it: a cascade entry's geo split and the node's egress policy. Both
// ask for the same reason (an ip/geoip rule cannot fire under IPIfNonMatch once
// a later rule matches everything), so honouring one and dropping the other
// would leave that feature's rules silently dead on any node running both.
func TestRender_DomainStrategy_CombinesBothRequests(t *testing.T) {
	strategyOf := func(t *testing.T, cascade *CascadeFragments, rf *RoutingFragments) string {
		t.Helper()
		cfg := validInbound()
		cfg.RoutingFragments = rf
		blob, err := renderConfigWithCascade(cfg, []xrayClient{{ID: "u1", Email: "u1"}}, cascade)
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(blob, &m); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		return m["routing"].(map[string]any)["domainStrategy"].(string)
	}
	policy := func(s string) *RoutingFragments {
		return &RoutingFragments{
			Rules:          []RoutingRule{{IP: []string{"geoip:ru"}, OutboundTag: "direct"}},
			DomainStrategy: s,
		}
	}
	cascadeWith := func(s string) *CascadeFragments {
		return &CascadeFragments{DomainStrategy: s}
	}

	cases := []struct {
		name    string
		cascade *CascadeFragments
		frags   *RoutingFragments
		want    string
	}{
		{"neither asks", nil, nil, "IPIfNonMatch"},
		{"only the geo split asks", cascadeWith("IPOnDemand"), nil, "IPOnDemand"},
		{"only the egress policy asks", nil, policy("IPOnDemand"), "IPOnDemand"},
		{"both ask", cascadeWith("IPOnDemand"), policy("IPOnDemand"), "IPOnDemand"},
		// The one that resolves more wins: the other feature's ip rules would
		// never fire otherwise, and an extra lookup is the cheaper mistake.
		{"they disagree", cascadeWith("AsIs"), policy("IPOnDemand"), "IPOnDemand"},
		{"they disagree, other way", cascadeWith("IPOnDemand"), policy("AsIs"), "IPOnDemand"},
		// xray refuses to start on an unknown strategy, so a drifted wire value
		// must fall back rather than reach the config and take the node down.
		{"unknown value falls back", cascadeWith("Nonsense"), policy("also-nonsense"), "IPIfNonMatch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := strategyOf(t, tc.cascade, tc.frags); got != tc.want {
				t.Errorf("domainStrategy = %q, want %q", got, tc.want)
			}
		})
	}
}

// A node can carry BOTH policies at once: its own egress policy and, as a
// cascade hop, that chain's geo split. They land in one rule list, so the order
// between them is the answer to "which one wins", and it has to be a decision
// rather than whatever the render happened to do.
//
// The node's own policy goes first. It answers "does this flow leave the
// machine here at all" (direct, the desync proxy, WARP), while the cascade's
// rules answer "for what stays in the tunnel, which way through the chain" and
// end in a catch-all that matches everything. Putting the cascade first would
// mean that catch-all shadows the node policy entirely.
func TestRender_NodePolicyBeforeCascadeRules(t *testing.T) {
	cfg := validInbound()
	cfg.RoutingFragments = &RoutingFragments{
		Rules: []RoutingRule{{Domain: []string{"geosite:youtube"}, OutboundTag: "direct"}},
	}
	cascade := &CascadeFragments{
		RoutingRules: []json.RawMessage{
			json.RawMessage(`{"type":"field","domain":["geosite:ru"],"outboundTag":"direct"}`),
			// The catch-all every cascade hop ends with.
			json.RawMessage(`{"type":"field","network":"tcp,udp","outboundTag":"link-out"}`),
		},
	}
	blob, err := renderConfigWithCascade(cfg, []xrayClient{{ID: "u1", Email: "u1"}}, cascade)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(blob, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	rules := m["routing"].(map[string]any)["rules"].([]any)

	policyIdx, splitIdx, catchAllIdx := -1, -1, -1
	for i, raw := range rules {
		r := raw.(map[string]any)
		if doms, ok := r["domain"].([]any); ok {
			for _, d := range doms {
				if d == "geosite:youtube" {
					policyIdx = i
				}
				if d == "geosite:ru" {
					splitIdx = i
				}
			}
		}
		if r["outboundTag"] == "link-out" {
			catchAllIdx = i
		}
	}
	if policyIdx == -1 || splitIdx == -1 || catchAllIdx == -1 {
		t.Fatalf("expected all three, got policy=%d split=%d catchAll=%d", policyIdx, splitIdx, catchAllIdx)
	}
	if !(policyIdx < splitIdx && splitIdx < catchAllIdx) {
		t.Errorf("order must be node policy -> cascade split -> catch-all, got %d, %d, %d",
			policyIdx, splitIdx, catchAllIdx)
	}
}

// The Vision flow belongs to the inbound, and the render has to take it from
// there. It used to be stamped on the user by AddUser, which read a struct
// ApplyInbound stopped updating the moment the panel began sending inbound ids
// - so on every current panel the server accounts came out with no flow while
// every share link asked for Vision. Nothing failed loudly: the REALITY
// handshake completes and the tunnel then carries nothing. Reproduced against
// a live node on 2026-08-24 before the fix.
func TestVLESSClientsTakeFlowFromTheInbound(t *testing.T) {
	in := validInbound()
	in.Flow = "xtls-rprx-vision"
	// Users as AddUser now stores them: identity only, no flow.
	users := []xrayClient{{ID: "u1", Email: "a"}, {ID: "u2", Email: "b"}}

	settings := buildUserInboundSettings(in, users)
	clients, ok := settings["clients"].([]map[string]any)
	if !ok || len(clients) != 2 {
		t.Fatalf("clients: got %#v", settings["clients"])
	}
	for i, c := range clients {
		if c["flow"] != "xtls-rprx-vision" {
			t.Errorf("client %d: flow = %v, want xtls-rprx-vision", i, c["flow"])
		}
	}
}

// The mirror case, and the reason the flow cannot simply be defaulted: Vision
// only works over raw/xhttp, and an inbound that does not run it must emit no
// flow at all, or xray rejects the account for the mismatch.
func TestVLESSClientsCarryNoFlowWhenTheInboundHasNone(t *testing.T) {
	settings := buildUserInboundSettings(validInbound(), []xrayClient{{ID: "u1", Email: "a"}})
	clients := settings["clients"].([]map[string]any)
	if _, present := clients[0]["flow"]; present {
		t.Errorf("flow must be absent when the inbound has none, got %v", clients[0]["flow"])
	}
}
