package hysteria

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

func dnsCfg(servers ...dto.DnsServer) *dto.DnsCfg { return &dto.DnsCfg{Servers: servers} }

func renderWith(t *testing.T, cfg *dto.DnsCfg, handoff *ChainHandoff) string {
	t.Helper()
	res, _, _ := nodeResolver(cfg)
	blob, err := renderConfigDns(goldenCfg, goldenInbound, handoff, res)
	if err != nil {
		t.Fatal(err)
	}
	return string(blob)
}

// 19.14: no setting, and a setting with nothing this core can draw, leave the
// bytes the goldens pin.
func TestNoResolverLeavesTheGoldens(t *testing.T) {
	want, _ := renderConfig(goldenCfg, goldenInbound, nil)
	if got := renderWith(t, nil, nil); got != string(want) {
		t.Errorf("a node with no setting changed:\n%s", got)
	}
	if got := renderWith(t, dnsCfg(dto.DnsServer{Address: "1.1.1.1", Domains: []string{"example.com"}}), nil); got != string(want) {
		t.Errorf("a setting with only domain servers drew a section:\n%s", got)
	}
	if strings.Contains(string(want), "resolver:") {
		t.Error("the golden render has a resolver")
	}
	checkGolden(t, "config-no-chain.yaml", want)
}

func TestOneGeneralServerDrawsTheSection(t *testing.T) {
	cases := []struct{ addr, want string }{
		{"1.1.1.1", "resolver:\n  type: udp\n  udp:\n    addr: \"1.1.1.1:53\"\n"},
		{"8.8.8.8:5353", "  type: udp\n  udp:\n    addr: \"8.8.8.8:5353\"\n"},
		{"[2606:4700::1111]:53", "    addr: \"[2606:4700::1111]:53\"\n"},
		{"2606:4700::1111", "    addr: \"[2606:4700::1111]:53\"\n"},
		{"tcp://9.9.9.9", "  type: tcp\n  tcp:\n    addr: \"9.9.9.9:53\"\n"},
		{"tls://1.1.1.1", "  type: tls\n  tls:\n    addr: \"1.1.1.1:853\"\n"},
		{"tls://dns.google", "    addr: \"dns.google:853\"\n    sni: \"dns.google\"\n"},
		{"https://cloudflare-dns.com/dns-query", "  type: https\n  https:\n    addr: \"cloudflare-dns.com:443\"\n    sni: \"cloudflare-dns.com\"\n"},
		{"https+local://1.1.1.1", "  type: https\n  https:\n    addr: \"1.1.1.1:443\"\n"},
	}
	for _, c := range cases {
		cfg := dnsCfg(dto.DnsServer{Address: c.addr})
		res, executed, _ := nodeResolver(cfg)
		if res == nil || !executed {
			t.Errorf("%s: res=%v executed=%v", c.addr, res, executed)
			continue
		}
		if got := renderWith(t, cfg, nil); !strings.Contains(got, c.want) {
			t.Errorf("%s: section not as expected, want %q in:\n%s", c.addr, c.want, got)
		}
	}
}

func TestResolverSitsBeforeTheOutbounds(t *testing.T) {
	got := renderWith(t, dnsCfg(dto.DnsServer{Address: "1.1.1.1"}), nil)
	r, o := strings.Index(got, "\nresolver:\n"), strings.Index(got, "\noutbounds:\n")
	if r < 0 || o < 0 || r > o || strings.Count(got, "resolver:") != 1 {
		t.Errorf("order/count of resolver and outbounds wrong:\n%s", got)
	}
}

func TestFirstGeneralServerWinsAndTheOthersAreNoted(t *testing.T) {
	cfg := dnsCfg(
		dto.DnsServer{Address: "quic://dns.example"}, // no such kind: skipped
		dto.DnsServer{Address: "9.9.9.9"},
		dto.DnsServer{Address: "1.1.1.1"},
	)
	res, executed, notes := nodeResolver(cfg)
	if res == nil || res.Addr != "9.9.9.9:53" || !executed {
		t.Fatalf("res=%+v executed=%v", res, executed)
	}
	if len(notes) != 2 {
		t.Errorf("notes = %v, want the quic one and the second general one", notes)
	}
}

// The outcome of task 1: hysteria chooses no resolver by domain, so a setting
// with domain rules is not executed whatever else it holds.
func TestDomainRulesAreNotExecuted(t *testing.T) {
	only := dnsCfg(dto.DnsServer{Address: "10.0.0.2", Domains: []string{"corp.example"}})
	if res, executed, _ := nodeResolver(only); res != nil || executed {
		t.Errorf("domain-only: res=%v executed=%v", res, executed)
	}
	both := dnsCfg(
		dto.DnsServer{Address: "10.0.0.2", Domains: []string{"corp.example"}},
		dto.DnsServer{Address: "1.1.1.1"},
	)
	res, executed, _ := nodeResolver(both)
	if res == nil || res.Addr != "1.1.1.1:53" {
		t.Errorf("the general server is still drawn: %+v", res)
	}
	if executed {
		t.Error("a setting with a domain rule reports as executed")
	}
}

func TestUntranslatableGeneralServerIsNotExecuted(t *testing.T) {
	for _, addr := range []string{"quic://dns.example", "h3://dns.example", "dns.example", "https://dns.example/custom", "fakedns", ""} {
		if res, executed, notes := nodeResolver(dnsCfg(dto.DnsServer{Address: addr})); res != nil || executed || len(notes) == 0 {
			t.Errorf("%q: res=%v executed=%v notes=%v", addr, res, executed, notes)
		}
	}
}

func TestLocalhostIsTheHostResolverAndExecuted(t *testing.T) {
	res, executed, _ := nodeResolver(dnsCfg(dto.DnsServer{Address: "localhost"}))
	if res != nil || !executed {
		t.Errorf("res=%v executed=%v", res, executed)
	}
}

func TestChainHandoffDrawsNoResolver(t *testing.T) {
	want, _ := renderConfig(goldenCfg, goldenInbound, goldenHandoff)
	if got := renderWith(t, dnsCfg(dto.DnsServer{Address: "1.1.1.1"}), goldenHandoff); got != string(want) {
		t.Errorf("a hand-off render changed with a resolver:\n%s", got)
	}
}

func TestResolverRefusesAHostileAddress(t *testing.T) {
	err := writeResolver(&bytes.Buffer{}, &resolver{Type: "udp", Addr: "1.1.1.1:53\"\nacme: {}"})
	if err == nil {
		t.Error("a newline in the address went into the YAML")
	}
}

// The real core takes what is drawn, for every kind.
func TestEngineAcceptsTheResolver(t *testing.T) {
	if hysteriaBin == "" {
		t.Skip("HYSTERIA_BIN not set")
	}
	for _, addr := range []string{"1.1.1.1", "[2606:4700::1111]:53", "tcp://9.9.9.9", "tls://dns.google", "tls://1.1.1.1:853", "https://cloudflare-dns.com/dns-query"} {
		blob := renderWith(t, dnsCfg(dto.DnsServer{Address: addr}), nil)
		if up, log := verdict(t, forEngine(t, []byte(blob))); !up {
			t.Errorf("hysteria refused the resolver for %s:\n%s\n%s", addr, blob, log)
		}
	}
}

func TestSameDnsIsByWireForm(t *testing.T) {
	a := dnsCfg(dto.DnsServer{Address: "1.1.1.1", Domains: []string{"a"}})
	var b dto.DnsCfg
	raw, _ := json.Marshal(a)
	_ = json.Unmarshal(raw, &b)
	if !sameDns(a, &b) || sameDns(a, nil) || !sameDns(nil, nil) {
		t.Error("sameDns")
	}
}
