package singbox

import (
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// 18.6: the node's IPv6 mode decides the direct outbound's strategy: off on a
// host with working IPv6 is the base shape (no domain_resolver, no dns block),
// on on a host without is the prefer_ipv6 resolver.
func TestTheNodesIPv6ModeDecidesTheDirectStrategy(t *testing.T) {
	prev := nodeHasIPv6
	defer func() { nodeHasIPv6 = prev; core.SetIPv6Mode(core.IPv6ModeAuto) }()
	for _, c := range []struct {
		mode  string
		works bool
		v6    bool
	}{
		{"auto", true, true}, {"auto", false, false},
		{"off", true, false}, {"off", false, false},
		{"on", true, true}, {"on", false, true},
	} {
		works := c.works
		nodeHasIPv6 = func() bool { return core.IPv6ByMode(core.IPv6ModeNow(), func() bool { return works }) }
		core.SetIPv6Mode(c.mode)
		out, dns := directOutbound()
		if !c.v6 {
			if out.DomainResolver != nil || dns != nil {
				t.Errorf("mode %q, host works=%v: want the base shape, got %+v %+v", c.mode, c.works, out, dns)
			}
			continue
		}
		if out.DomainResolver == nil || out.DomainResolver.Strategy != "prefer_ipv6" || dns == nil ||
			!strings.Contains(dns.Servers[0].Tag, out.DomainResolver.Server) {
			t.Errorf("mode %q, host works=%v: want the prefer_ipv6 resolver, got %+v %+v", c.mode, c.works, out, dns)
		}
	}
}
