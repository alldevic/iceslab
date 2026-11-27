package shadowsocks

import (
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// 18.6: the node's IPv6 mode decides the family the second xray process
// resolves and dials with, like the xray adapter's: off is UseIPv4 on a host
// with working IPv6, on is UseIP on one without.
func TestTheNodesIPv6ModeDecidesTheFamilyShadowsocksUses(t *testing.T) {
	prev := nodeHasIPv6
	defer func() { nodeHasIPv6 = prev; core.SetIPv6Mode(core.IPv6ModeAuto) }()
	for _, c := range []struct {
		mode  string
		works bool
		want  string
	}{
		{"auto", true, "UseIP"}, {"auto", false, "UseIPv4"},
		{"off", true, "UseIPv4"}, {"off", false, "UseIPv4"},
		{"on", true, "UseIP"}, {"on", false, "UseIP"},
	} {
		works := c.works
		nodeHasIPv6 = func() bool { return core.IPv6ByMode(core.IPv6ModeNow(), func() bool { return works }) }
		core.SetIPv6Mode(c.mode)
		m := renderToMap(t, ssInbound(ssCases[1].method, ssCases[1].psk), ssUsers)
		dns, _ := m["dns"].(map[string]any)
		if dns["queryStrategy"] != c.want {
			t.Errorf("mode %q, host works=%v: dns queryStrategy %v, want %s", c.mode, c.works, dns["queryStrategy"], c.want)
		}
		got := "<no direct>"
		for _, o := range m["outbounds"].([]any) {
			ob := o.(map[string]any)
			if ob["tag"] == "direct" {
				s, _ := ob["settings"].(map[string]any)
				got, _ = s["domainStrategy"].(string)
			}
		}
		if got != c.want {
			t.Errorf("mode %q, host works=%v: direct domainStrategy %q, want %q", c.mode, c.works, got, c.want)
		}
	}
}
