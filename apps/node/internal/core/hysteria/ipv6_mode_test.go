package hysteria

import (
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// 18.6: the node's IPv6 mode decides hysteria's direct mode: "64" (IPv6 first)
// for on, or auto on a host with working IPv6; "46" for off, or auto without.
func TestTheNodesIPv6ModeDecidesHysteriasDirectMode(t *testing.T) {
	prev := nodeHasIPv6
	defer func() { nodeHasIPv6 = prev; core.SetIPv6Mode(core.IPv6ModeAuto) }()
	for _, c := range []struct {
		mode  string
		works bool
		want  string
	}{
		{"auto", true, `mode: "64"`}, {"auto", false, `mode: "46"`},
		{"off", true, `mode: "46"`}, {"off", false, `mode: "46"`},
		{"on", true, `mode: "64"`}, {"on", false, `mode: "64"`},
	} {
		works := c.works
		nodeHasIPv6 = func() bool { return core.IPv6ByMode(core.IPv6ModeNow(), func() bool { return works }) }
		core.SetIPv6Mode(c.mode)
		blob, err := renderConfig(goldenCfg, goldenInbound, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(blob), c.want) {
			t.Errorf("mode %q, host works=%v: want %s, got:\n%s", c.mode, c.works, c.want, blob)
		}
	}
}
