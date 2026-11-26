package dto

import (
	"encoding/json"
	"testing"
)

// NativeEngine answers "which core renders this protocol" for every inbound the
// panel pushes without pinning one, which is most of them: the field was added
// with engine-choice and older bindings carry nothing.
//
// The dispatcher matches an inbound to an adapter by BOTH Name()==protocol AND
// Engine()==resolved engine, so a wrong answer here does not fail loudly - no
// adapter matches, the inbound is counted as skipped, and the protocol simply
// never comes up on that node while the panel still lists it as enabled.
//
// The table names every ProtocolName constant. mtproto and mieru have no
// constant in this package (their adapters own the name), so they are spelled
// out: they take the default branch, and an answer other than their own name
// would strand them the same way.
func TestNativeEngine(t *testing.T) {
	for _, tc := range []struct {
		proto ProtocolName
		want  EngineName
		why   string
	}{
		// Shadowsocks has no core of its own here: it is rendered by xray.
		{ProtocolShadowsocks, EngineXray, "shadowsocks is served by xray-core, not by a shadowsocks binary"},
		// sing-box-only protocols. No native core exists to fall back to.
		{ProtocolTuic, EngineSingbox, "tuic exists only on the sing-box engine"},
		{ProtocolAnytls, EngineSingbox, "anytls exists only on the sing-box engine"},
		{ProtocolShadowtls, EngineSingbox, "shadowtls exists only on the sing-box engine"},
		// Protocols whose native core carries the protocol's own name.
		{ProtocolXray, EngineXray, ""},
		{ProtocolHysteria, EngineHysteria, ""},
		{ProtocolAmneziaWG, EngineAmneziawg, ""},
		{ProtocolNaive, EngineName("naive"), ""},
		{ProtocolName("mtproto"), EngineName("mtproto"), ""},
		{ProtocolName("mieru"), EngineName("mieru"), ""},
	} {
		if got := NativeEngine(tc.proto); got != tc.want {
			msg := tc.why
			if msg == "" {
				msg = "a protocol with a native core of the same name"
			}
			t.Errorf("NativeEngine(%q) = %q, want %q: %s", tc.proto, got, tc.want, msg)
		}
	}
}

// An inbound created before engine-choice carries no engine at all, and one
// created after may pin a core the protocol is not native to. Resolving those
// two the same way would either strand every old binding or ignore every
// deliberate choice.
func TestResolvedEnginePrefersThePinOverTheDefault(t *testing.T) {
	legacy := InboundDto{Protocol: ProtocolShadowsocks}
	if got := legacy.ResolvedEngine(); got != EngineXray {
		t.Errorf("an inbound with no engine resolved to %q, want the protocol's native core %q", got, EngineXray)
	}
	pinned := InboundDto{Protocol: ProtocolShadowsocks, Engine: EngineSingbox}
	if got := pinned.ResolvedEngine(); got != EngineSingbox {
		t.Errorf("an inbound pinned to %q resolved to %q: the operator's choice was ignored", EngineSingbox, got)
	}
}

func TestSingboxUserCorePayload(t *testing.T) {
	socks := &ChainUserCoreSocks{Port: 26000, Username: "u", Password: "p"}
	frag := json.RawMessage(`{"outbounds":[]}`)
	tp := &ChainUserCoreTProxy{Port: 1, Mark: 2}
	for _, tc := range []struct {
		name string
		core ChainUserCore
		ok   bool
	}{
		{"tuic", ChainUserCore{Engine: EngineSingbox, Protocol: ProtocolTuic, Socks: socks}, true},
		{"anytls", ChainUserCore{Engine: EngineSingbox, Protocol: ProtocolAnytls, Socks: socks}, true},
		{"shadowtls", ChainUserCore{Engine: EngineSingbox, Protocol: ProtocolShadowtls, Socks: socks}, true},
		{"shadowsocks", ChainUserCore{Engine: EngineSingbox, Protocol: ProtocolShadowsocks, Socks: socks}, true},
		{"no socks", ChainUserCore{Engine: EngineSingbox, Protocol: ProtocolTuic}, false},
		{"no protocol", ChainUserCore{Engine: EngineSingbox, Socks: socks}, false},
		{"protocol that is no entry", ChainUserCore{Engine: EngineSingbox, Protocol: ProtocolXray, Socks: socks}, false},
		{"fragments", ChainUserCore{Engine: EngineSingbox, Protocol: ProtocolTuic, Socks: socks, Fragments: frag}, false},
		{"tproxy", ChainUserCore{Engine: EngineSingbox, Protocol: ProtocolTuic, Socks: socks, TProxy: tp}, false},
		{"tproxy3", ChainUserCore{Engine: EngineSingbox, Protocol: ProtocolTuic, Socks: socks, TProxy3: tp}, false},
	} {
		got, err := tc.core.Payload()
		if (err == nil) != tc.ok {
			t.Errorf("%s: err=%v, want ok=%v", tc.name, err, tc.ok)
		}
		if tc.ok && string(got) != `{"port":26000,"username":"u","password":"p"}` {
			t.Errorf("%s: payload %s", tc.name, got)
		}
	}
}
