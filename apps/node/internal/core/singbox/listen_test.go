package singbox

import (
	"strings"
	"testing"
)

// The goldens are the base's: pin the host as one without a dual-stack `::`.
func init() { listenAddr = func() string { return "0.0.0.0" } }

// All six inbounds the renderers build take the chosen address.
func TestEveryInboundListensOnTheChosenAddress(t *testing.T) {
	defer func(f func() string) { listenAddr = f }(listenAddr)
	users := map[string]userEntry{"u1": {UUID: "uuid-1", Password: "pw1", Username: "alice"}}
	renders := map[string]func() ([]byte, error){
		"tuic": func() ([]byte, error) {
			return renderConfig("c", "k", "", InboundConfig{ListenPort: 8443, ServerName: "a.b"}, users)
		},
		"anytls": func() ([]byte, error) {
			return renderAnytlsConfig("c", "k", "", InboundConfig{ListenPort: 8443, ServerName: "a.b"}, users)
		},
		"hysteria2": func() ([]byte, error) {
			return renderHysteria2Config("/c", "/k", "", InboundConfig{ListenPort: 443, ObfsPassword: "o", MasqueradeURL: "https://a.b"}, users)
		},
		"shadowsocks": func() ([]byte, error) {
			return renderShadowsocksConfig("", "", InboundConfig{ListenPort: 8388, Method: "2022-blake3-aes-256-gcm", ServerPSK: "P"}, users)
		},
		"shadowtls": func() ([]byte, error) {
			return renderShadowtlsConfig("", InboundConfig{ListenPort: 443, ShadowtlsHandshake: "a.b:443", Method: "2022-blake3-aes-128-gcm", ServerPSK: "K"}, users)
		},
		"vless": func() ([]byte, error) {
			return renderXrayFamilyConfig("127.0.0.1:8084", InboundConfig{
				ListenPort: 443, Subprotocol: "vless", RealityDest: "a.b:443", RealityServerName: "a.b",
				RealityPrivateKey: "P", RealityShortIDsCSV: "01", Flow: "xtls-rprx-vision"}, users)
		},
	}
	for _, pinned := range []string{"::", "0.0.0.0"} {
		listenAddr = func() string { return pinned }
		for name, r := range renders {
			blob, err := r()
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if !strings.Contains(string(blob), `"listen":"`+pinned+`"`) && !strings.Contains(string(blob), `"listen": "`+pinned+`"`) {
				t.Errorf("%s on %q: no such listener in\n%s", name, pinned, blob)
			}
		}
	}
}
