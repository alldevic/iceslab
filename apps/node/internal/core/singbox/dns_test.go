package singbox

import (
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

func dnsJSON(t *testing.T, s *sbDNS) string {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestNoResolverIsNoSection(t *testing.T) {
	if s, notes := nodeDNS(nil, true); s != nil || notes != nil {
		t.Fatalf("nil setting gave %v %v", s, notes)
	}
}

func TestOneGeneralServer(t *testing.T) {
	s, notes := nodeDNS(&dto.DnsCfg{Servers: []dto.DnsServer{{Address: "77.88.8.8"}}}, false)
	want := `{"servers":[{"type":"udp","tag":"node-dns-1","server":"77.88.8.8"},{"type":"local","tag":"egress-dns"}],"final":"node-dns-1"}`
	if got := dnsJSON(t, s); got != want || len(notes) != 0 {
		t.Fatalf("got %s %v", got, notes)
	}
}

func TestAServerWithNamesIsARuleAndTheHostResolverStaysTheRest(t *testing.T) {
	s, notes := nodeDNS(&dto.DnsCfg{Servers: []dto.DnsServer{
		{Address: "10.0.0.53:5300", Domains: []string{"corp.test", "domain:lan", "full:one.example"}, SkipFallback: true},
	}}, false)
	want := `{"servers":[{"type":"udp","tag":"node-dns-1","server":"10.0.0.53","server_port":5300},{"type":"local","tag":"egress-dns"}],` +
		`"rules":[{"domain_suffix":["corp.test","lan"],"action":"route","server":"node-dns-1"},{"domain":["one.example"],"action":"route","server":"node-dns-1"}],"final":"egress-dns"}`
	if got := dnsJSON(t, s); got != want || len(notes) != 0 {
		t.Fatalf("got %s %v", got, notes)
	}
}

func TestSeveralServersKeepTheirOrderAndKinds(t *testing.T) {
	s, notes := nodeDNS(&dto.DnsCfg{
		Servers: []dto.DnsServer{
			{Address: "tcp://10.0.0.1", Domains: []string{"a.test"}},
			{Address: "https://dns.example/dns-query", Domains: []string{"keyword:b", "regexp:^c"}},
			{Address: "tls://10.0.0.3:8853"},
			{Address: "localhost", Domains: []string{"d.test"}},
			{Address: "9.9.9.9"},
		},
		QueryStrategy: "UseIPv4", DisableCache: true,
	}, true)
	got := dnsJSON(t, s)
	for _, w := range []string{
		`{"type":"tcp","tag":"node-dns-1","server":"10.0.0.1"}`,
		`{"type":"https","tag":"node-dns-2","server":"dns.example","domain_resolver":{"server":"egress-dns"}}`,
		`{"type":"tls","tag":"node-dns-3","server":"10.0.0.3","server_port":8853}`,
		`{"type":"local","tag":"node-dns-4"}`,
		`"final":"node-dns-3"`, `"strategy":"ipv4_only"`, `"disable_cache":true`,
		`{"domain_suffix":["a.test"],"action":"route","server":"node-dns-1"},{"domain_keyword":["b"],"action":"route","server":"node-dns-2"},{"domain_regex":["^c"],"action":"route","server":"node-dns-2"},{"domain_suffix":["d.test"],"action":"route","server":"node-dns-4"}`,
	} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %s in %s", w, got)
		}
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "9.9.9.9") {
		t.Errorf("the second general server has to be named in the notes: %v", notes)
	}
}

func TestAServerWithOnlyASetIsSkippedAndSaidSo(t *testing.T) {
	s, notes := nodeDNS(&dto.DnsCfg{Servers: []dto.DnsServer{
		{Address: "10.0.0.1", Domains: []string{"geosite:ru", "ext:corp:lists"}, ExpectIPs: []string{"geoip:ru"}},
		{Address: "10.0.0.2", Domains: []string{"geosite:ru", "x.test"}, ExpectIPs: []string{"geoip:ru"}},
		{Address: "fakedns"},
		{Address: "quic+local://10.0.0.4"},
	}}, false)
	got := dnsJSON(t, s)
	if strings.Contains(got, "10.0.0.1") || !strings.Contains(got, `"node-dns-2"`) || strings.Contains(got, "fakedns") || !strings.Contains(got, `"type":"quic"`) {
		t.Fatalf("wrong servers kept: %s", got)
	}
	joined := strings.Join(notes, "\n")
	for _, w := range []string{"server 1 (10.0.0.1) skipped", "geosite:ru", "expectIps not enforced", "server 3 (fakedns) skipped"} {
		if !strings.Contains(joined, w) {
			t.Errorf("notes lack %q:\n%s", w, joined)
		}
	}
	if s, _ := nodeDNS(&dto.DnsCfg{Servers: []dto.DnsServer{{Address: "10.0.0.1", Domains: []string{"geosite:ru"}}}}, false); s != nil {
		t.Error("nothing executable must leave no section, not a section that makes a set-only server the general resolver")
	}
}

func TestTheIPv6PreferenceMovesFromTheOutboundToTheSection(t *testing.T) {
	cfg := &dto.DnsCfg{Servers: []dto.DnsServer{{Address: "10.0.0.1"}}}
	if s, _ := nodeDNS(cfg, true); s.Strategy != "prefer_ipv6" {
		t.Errorf("strategy %q", s.Strategy)
	}
	if s, _ := nodeDNS(cfg, false); s.Strategy != "" {
		t.Errorf("strategy %q", s.Strategy)
	}
	cfg.QueryStrategy = "UseIPv6"
	if s, _ := nodeDNS(cfg, false); s.Strategy != "ipv6_only" {
		t.Errorf("strategy %q", s.Strategy)
	}
}

// Every one of the six render functions, and the multi-inbound merge, carry the
// section, and the direct outbound gives up the resolver that would skip it.
func TestEveryRenderCarriesTheSectionAndTheRouteSendsNamesThroughIt(t *testing.T) {
	defer func(f func() bool) { nodeHasIPv6 = f }(nodeHasIPv6)
	nodeHasIPv6 = func() bool { return true }
	users := map[string]userEntry{"u1": {UUID: "5f0c9a3e-2b7d-4e51-9c8a-1d2e3f4a5b6c", Password: "pw"}}
	psk := "AAAAAAAAAAAAAAAAAAAAAA=="
	cases := map[string]InboundConfig{
		"tuic":        {ListenPort: 8443, ServerName: "n.example.test"},
		"anytls":      {ListenPort: 8444, ServerName: "n.example.test"},
		"hysteria":    {ListenPort: 8445},
		"xray":        {ListenPort: 8446, Subprotocol: "vless", RealityDest: "www.example.com:443", RealityServerName: "www.example.com", RealityPrivateKey: "k", RealityShortIDsCSV: "0123456789abcdef"},
		"shadowsocks": {ListenPort: 8447, Method: "2022-blake3-aes-128-gcm", ServerPSK: psk},
		"shadowtls":   {ListenPort: 8448, ShadowtlsHandshake: "www.example.com", Method: "2022-blake3-aes-128-gcm", ServerPSK: psk},
	}
	for proto, in := range cases {
		a := New(Config{Protocol: proto}, slog.New(slog.NewTextHandler(io.Discard, nil)))
		if err := a.ApplyDns(json.RawMessage(`{"servers":[{"address":"10.0.0.53","domains":["corp.test"]}]}`)); err != nil {
			t.Fatal(err)
		}
		second := in
		second.ListenPort += 100
		for name, blob := range map[string]func() ([]byte, error){
			"render": func() ([]byte, error) { return a.render("c", "k", "", in, users) },
			"renderAll": func() ([]byte, error) {
				return a.renderAll("c", "k", "", []heldInbound{{id: "a", cfg: in}, {id: "b", cfg: second}}, users)
			},
		} {
			b, err := blob()
			if err != nil {
				t.Fatalf("%s %s: %v", proto, name, err)
			}
			var doc struct {
				DNS       *sbDNS       `json:"dns"`
				Outbounds []sbOutbound `json:"outbounds"`
				Route     struct {
					Rules []map[string]any `json:"rules"`
				} `json:"route"`
			}
			if err := json.Unmarshal(b, &doc); err != nil {
				t.Fatal(err)
			}
			if doc.DNS == nil || len(doc.DNS.Rules) != 1 || doc.DNS.Final != egressDNSTag || doc.DNS.Strategy != "prefer_ipv6" {
				t.Errorf("%s %s: section %+v", proto, name, doc.DNS)
			}
			if len(doc.Route.Rules) != 1 || doc.Route.Rules[0]["action"] != "resolve" || doc.Route.Rules[0]["server"] != nil {
				t.Errorf("%s %s: no server-less resolve rule, so names would skip dns.rules: %+v", proto, name, doc.Route)
			}
			if len(doc.Outbounds) != 1 || doc.Outbounds[0].DomainResolver == nil || doc.Outbounds[0].DomainResolver.Strategy != "prefer_ipv6" {
				t.Errorf("%s %s: 18.5's outbound resolver was changed: %+v", proto, name, doc.Outbounds)
			}
		}
	}
}

// Pinned engine: every protocol's render with the section, and a name a client
// asks for, resolved by the node's rule and by nobody else.
func TestTheNodesResolverAnswersTheNamesItsRuleCovers(t *testing.T) {
	bin := singboxBin(t)
	for _, v6 := range []bool{false, true} {
		func() {
			defer func(f func() bool) { nodeHasIPv6 = f }(nodeHasIPv6)
			nodeHasIPv6 = func() bool { return v6 }
			theNodesResolverAnswersTheNamesItsRuleCovers(t, bin)
		}()
	}
}

func theNodesResolverAnswersTheNamesItsRuleCovers(t *testing.T, bin string) {
	dir := t.TempDir()
	cert, key := selfSigned(t, dir)
	users := map[string]userEntry{"u-1": {UUID: "5f0c9a3e-2b7d-4e51-9c8a-1d2e3f4a5b6c", Password: "pw"}}

	queries := make(chan string, 16)
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	go func() {
		buf := make([]byte, 512)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			end := 12
			var labels []string
			for end < n && buf[end] != 0 {
				labels = append(labels, string(buf[end+1:end+1+int(buf[end])]))
				end += int(buf[end]) + 1
			}
			qtype := int(buf[end+1])<<8 | int(buf[end+2])
			queries <- strings.Join(labels, ".")
			resp := append([]byte{}, buf[:2]...)
			resp = append(resp, 0x81, 0x80, buf[4], buf[5], 0, 0, 0, 0, 0, 0)
			if qtype == 1 {
				resp[7] = 1
				resp = append(resp, buf[12:end+5]...)
				resp = append(resp, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1)
			} else {
				resp = append(resp, buf[12:end+5]...)
			}
			_, _ = pc.WriteTo(resp, from)
		}
	}()
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) }))
	defer web.Close()
	_, webPort, _ := net.SplitHostPort(web.Listener.Addr().String())
	dnsHost, dnsPort, _ := net.SplitHostPort(pc.LocalAddr().String())

	a := New(Config{Protocol: "tuic", BinaryPath: bin}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := a.ApplyDns(json.RawMessage(`{"servers":[{"address":"` + dnsHost + `:` + dnsPort + `","domains":["probe.test"]}]}`)); err != nil {
		t.Fatal(err)
	}
	blob, err := a.render(cert, key, "", InboundConfig{ListenPort: 29301, ServerName: "n.example.test"}, users)
	if err != nil {
		t.Fatal(err)
	}
	// The rendered section, outbound and route, behind a plain socks inbound:
	// the inbound is not what is under test.
	var doc map[string]any
	_ = json.Unmarshal(blob, &doc)
	doc["inbounds"] = []any{map[string]any{"type": "mixed", "tag": "in", "listen": "127.0.0.1", "listen_port": 29302}}
	delete(doc, "experimental")
	blob, _ = json.Marshal(doc)
	path := filepath.Join(dir, "live.json")
	_ = os.WriteFile(path, blob, 0o600)
	if out, err := exec.Command(bin, "check", "-c", path).CombinedOutput(); err != nil {
		t.Fatalf("check: %v\n%s", err, out)
	}
	cmd := exec.Command(bin, "run", "-c", path)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() }()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if c, err := net.Dial("tcp", "127.0.0.1:29302"); err == nil {
			c.Close()
			break
		} else if time.Now().After(deadline) {
			t.Fatal("sing-box did not come up")
		}
	}
	get := func(host string) error {
		out, err := exec.Command("curl", "-s", "-m", "5", "--socks5-hostname", "127.0.0.1:29302", "http://"+host+":"+webPort+"/").CombinedOutput()
		if err != nil || string(out) != "ok" {
			return err
		}
		return nil
	}
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skip("no curl")
	}
	if err := get("a.probe.test"); err != nil {
		t.Fatalf("a name the rule covers did not resolve through the node's server: %v", err)
	}
	select {
	case q := <-queries:
		if q != "a.probe.test" {
			t.Errorf("the node's server was asked %q", q)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the node's server was never asked: the outbound resolved the name by itself")
	}
	// A name outside the rule goes to the host's resolver, not to the server.
	_ = get("localhost")
	select {
	case q := <-queries:
		if q != "a.probe.test" {
			t.Errorf("a name outside the rule reached the node's server: %q", q)
		}
	default:
	}
}

var _ core.DnsReceiver = (*Adapter)(nil)

// A resolver with every kind of server, through the engine's own check, for each
// protocol and for two inbounds of one in one process.
func TestEveryProtocolRendersADnsSectionThePinnedEngineTakes(t *testing.T) {
	bin := singboxBin(t)
	dir := t.TempDir()
	cert, key := selfSigned(t, dir)
	users := map[string]userEntry{"u-1": {UUID: "5f0c9a3e-2b7d-4e51-9c8a-1d2e3f4a5b6c", Password: "5f0c9a3e-2b7d-4e51-9c8a-1d2e3f4a5b6c"}}
	cases := map[string]InboundConfig{
		"tuic":     {ListenPort: 29011, ServerName: "n.example.test"},
		"anytls":   {ListenPort: 29012, ServerName: "n.example.test"},
		"hysteria": {ListenPort: 29013},
		"xray": {ListenPort: 29014, Subprotocol: "vless", RealityDest: "www.example.com:443", RealityServerName: "www.example.com",
			RealityPrivateKey: realityKey(t, bin), RealityShortIDsCSV: "0123456789abcdef"},
		"shadowsocks": {ListenPort: 29015, Method: "2022-blake3-aes-128-gcm", ServerPSK: ssKey()},
		"shadowtls":   {ListenPort: 29016, ShadowtlsHandshake: "www.example.com", Method: "2022-blake3-aes-128-gcm", ServerPSK: ssKey()},
	}
	setting := json.RawMessage(`{"servers":[
		{"address":"tcp://10.0.0.1","domains":["a.test","full:b.test"]},
		{"address":"https://dns.example/dns-query","domains":["keyword:c","regexp:^d"]},
		{"address":"tls://10.0.0.3:8853","domains":["geosite:ru","e.test"]},
		{"address":"localhost","domains":["f.test"]},
		{"address":"[2001:db8::53]:5300"}],
		"queryStrategy":"UseIPv4","disableCache":true}`)
	for _, v6 := range []bool{false, true} {
		func() {
			defer func(f func() bool) { nodeHasIPv6 = f }(nodeHasIPv6)
			nodeHasIPv6 = func() bool { return v6 }
			for proto, in := range cases {
				a := New(Config{Protocol: proto, BinaryPath: bin, StatsListen: "127.0.0.1:29100"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
				if err := a.ApplyDns(setting); err != nil {
					t.Fatal(err)
				}
				second := in
				second.ListenPort += 100
				blob, err := a.renderAll(cert, key, a.cfg.StatsListen, []heldInbound{{id: "aaaaaaaa-1", cfg: in}, {id: "bbbbbbbb-2", cfg: second}}, users)
				if err != nil {
					t.Fatalf("%s: %v", proto, err)
				}
				path := filepath.Join(t.TempDir(), "config.json")
				_ = os.WriteFile(path, blob, 0o600)
				if out, err := exec.Command(bin, "check", "-c", path).CombinedOutput(); err != nil {
					t.Fatalf("sing-box check refused the %s render with a dns section (ipv6=%v): %v\n%s\n%s", proto, v6, err, out, blob)
				}
			}
		}()
	}
}
