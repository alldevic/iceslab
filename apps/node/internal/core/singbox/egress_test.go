package singbox

import (
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
)

func init() { nodeHasIPv6 = func() bool { return false } }

// 18.5: the family a direct outbound dials with follows core.EffectiveIPv6,
// the same answer xray and shadowsocks read. Without IPv6 the render is the
// base's (no field, no dns block); with it, every protocol's direct outbound
// names a local resolver that prefers IPv6.
func TestTheDirectOutboundFollowsTheNodesIPv6(t *testing.T) {
	cert, key := "/etc/sing-box/cert.pem", "/etc/sing-box/key.pem"
	users := map[string]userEntry{"u1": {UUID: "5f0c9a3e-2b7d-4e51-9c8a-1d2e3f4a5b6c", Password: "pw", Username: "a"}}
	psk := "AAAAAAAAAAAAAAAAAAAAAA=="
	cases := map[string]InboundConfig{
		"tuic":        {ListenPort: 8443, ServerName: "n.example.test"},
		"anytls":      {ListenPort: 8444, ServerName: "n.example.test"},
		"hysteria":    {ListenPort: 8445},
		"xray":        {ListenPort: 8446, Subprotocol: "vless", RealityDest: "www.example.com:443", RealityServerName: "www.example.com", RealityPrivateKey: "k", RealityShortIDsCSV: "0123456789abcdef"},
		"shadowsocks": {ListenPort: 8447, Method: "2022-blake3-aes-128-gcm", ServerPSK: psk},
		"shadowtls":   {ListenPort: 8448, ShadowtlsHandshake: "www.example.com", Method: "2022-blake3-aes-128-gcm", ServerPSK: psk},
	}
	defer func(f func() bool) { nodeHasIPv6 = f }(nodeHasIPv6)
	for proto, in := range cases {
		a := New(Config{Protocol: proto}, slog.New(slog.NewTextHandler(io.Discard, nil)))
		for _, v6 := range []bool{false, true} {
			nodeHasIPv6 = func() bool { return v6 }
			blob, err := a.render(cert, key, "", in, users)
			if err != nil {
				t.Fatalf("%s render: %v", proto, err)
			}
			var doc struct {
				DNS       *sbDNS       `json:"dns"`
				Outbounds []sbOutbound `json:"outbounds"`
			}
			if err := json.Unmarshal(blob, &doc); err != nil {
				t.Fatalf("%s: %v", proto, err)
			}
			if len(doc.Outbounds) != 1 || doc.Outbounds[0].Tag != "direct" {
				t.Fatalf("%s v6=%v outbounds %+v", proto, v6, doc.Outbounds)
			}
			r := doc.Outbounds[0].DomainResolver
			if !v6 {
				if r != nil || doc.DNS != nil || strings.Contains(string(blob), "domain_resolver") || strings.Contains(string(blob), `"dns"`) {
					t.Errorf("%s: no IPv6 must render the base shape, got %s", proto, blob)
				}
				continue
			}
			if r == nil || r.Strategy != "prefer_ipv6" || doc.DNS == nil || len(doc.DNS.Servers) != 1 ||
				doc.DNS.Servers[0].Tag != r.Server || doc.DNS.Servers[0].Type != "local" {
				t.Errorf("%s: IPv6 must name a local resolver that prefers it, got %s", proto, blob)
			}
		}
	}
}
