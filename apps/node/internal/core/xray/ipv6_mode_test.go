package xray

import (
	"os"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// pinHost makes this machine's own IPv6 answer `works` and leaves the mode to
// the real rule (core.IPv6ByMode), so the tests below run the path a push takes.
func pinHost(t *testing.T, works bool) {
	t.Helper()
	prev := nodeHasIPv6
	t.Cleanup(func() { nodeHasIPv6 = prev; core.SetIPv6Mode(core.IPv6ModeAuto) })
	nodeHasIPv6 = func() bool {
		return core.IPv6ByMode(core.IPv6ModeNow(), func() bool { return works })
	}
}

// 18.6: the mode decides the address family xray resolves and dials with:
// off on a node with working IPv6 is UseIPv4, on on a node without is UseIP,
// auto is what the check said.
func TestTheNodesIPv6ModeDecidesTheFamilyXrayUses(t *testing.T) {
	for _, c := range []struct {
		mode  string
		works bool
		want  string
	}{
		{"auto", true, "UseIP"}, {"auto", false, "UseIPv4"},
		{"off", true, "UseIPv4"}, {"off", false, "UseIPv4"},
		{"on", true, "UseIP"}, {"on", false, "UseIP"},
		{"", true, "UseIP"},
	} {
		pinHost(t, c.works)
		core.SetIPv6Mode(c.mode)
		if got := renderedDns(t, nil)["queryStrategy"]; got != c.want {
			t.Errorf("mode %q, host works=%v: dns queryStrategy %v, want %s", c.mode, c.works, got, c.want)
		}
	}
}

// A push that changes only the mode (the inbound is the same) is not
// "unchanged": the config is drawn again, or the switch would change nothing
// until some other edit restarted the core.
func TestAChangeOfModeAloneRedrawsTheConfig(t *testing.T) {
	pinHost(t, true)
	a := dnsAdapter(t)
	core.SetIPv6Mode("auto")
	push := func() {
		t.Helper()
		if err := a.ApplyInbound(443, []byte(`{
			"inboundId": "ib-1",
			"realityDest": "www.cloudflare.com:443",
			"realityServerNames": ["www.cloudflare.com"],
			"realityPrivateKey": "aGVsbG8td29ybGQtdGhpcy1pcy1hLWZha2Uta2V5MDA",
			"realityShortIds": ["0123456789abcdef"]
		}`)); err != nil {
			t.Fatalf("ApplyInbound: %v", err)
		}
	}
	push()
	read := func() string {
		b, err := os.ReadFile(a.cfg.ConfigPath)
		if err != nil {
			t.Fatalf("config not written: %v", err)
		}
		return string(b)
	}
	if got := read(); !strings.Contains(got, `"UseIP"`) {
		t.Fatalf("auto with IPv6 should draw UseIP:\n%s", got)
	}
	core.SetIPv6Mode("off")
	push()
	if got := read(); strings.Contains(got, `"UseIP"`) || !strings.Contains(got, `"UseIPv4"`) {
		t.Errorf("off was not drawn:\n%s", got)
	}
}
