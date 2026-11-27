package mtproto

import (
	"strings"
	"testing"
)

// The goldens are the base's: pin the host as one without a dual-stack `::`.
func init() { listenAddr = func() string { return "0.0.0.0" } }

func TestBindToFollowsTheHost(t *testing.T) {
	defer func(f func() string) { listenAddr = f }(listenAddr)
	domain := "www.cloudflare.com"
	cfg := InboundConfig{Domain: domain, Secret: validSecret(domain), ListenPort: 443, StatsPort: 3129}
	for pinned, want := range map[string]string{
		"0.0.0.0": `bind-to = "0.0.0.0:443"`,
		"::":      `bind-to = "[::]:443"`, // brackets: a bare "::443" is no address
	} {
		listenAddr = func() string { return pinned }
		blob, err := renderConfig(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(blob), want) {
			t.Errorf("on %q: want %s in\n%s", pinned, want, blob)
		}
	}
}
