package dto

import "testing"

// NativeEngine answers "which core renders this protocol" for every inbound the
// panel pushes without pinning one, which is most of them: the field was added
// with engine-choice and older bindings carry nothing.
//
// The dispatcher matches an inbound to an adapter by BOTH Name()==protocol AND
// Engine()==resolved engine, so a wrong answer here does not fail loudly - no
// adapter matches, the inbound is counted as skipped, and the protocol simply
// never comes up on that node while the panel still lists it as enabled.
//
// Measured before writing this: `go test ./... -coverpkg=./internal/dto` never
// entered either of the two non-default branches. Both of them are the ones
// that are not guessable from the protocol name.
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
		{ProtocolAmneziaWG, EngineName("amneziawg"), ""},
		{ProtocolWireguard, EngineName("wireguard"), ""},
		{ProtocolNaive, EngineName("naive"), ""},
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
