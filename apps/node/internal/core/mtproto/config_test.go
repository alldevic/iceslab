package mtproto

import (
	"encoding/hex"
	"strings"
	"testing"
)

// validSecret builds a secret shaped the way the panel's derivation shapes
// them: `ee` + 32 hex chars (a 16-byte secret) + the domain, hex-encoded.
//
// Deliberately NOT the panel's formula. The agent had a copy of that
// derivation, exported and called by nothing; it was removed 2026-08-27 so
// there is one implementation and nothing for it to drift against. What these
// fixtures need is a well-SHAPED secret, which is exactly what the agent
// checks, and the domain tail varies with the domain the way a real one does.
func validSecret(domain string) string {
	return "ee" + strings.Repeat("ab", 16) + hex.EncodeToString([]byte(domain))
}

func TestInboundValidation(t *testing.T) {
	cases := []struct {
		name    string
		mut     func(*InboundConfig)
		wantErr string
	}{
		{"missing domain", func(c *InboundConfig) { c.Domain = "" }, "Domain is required"},
		{"slash in domain", func(c *InboundConfig) { c.Domain = "evil/path" }, "forbidden"},
		{"colon in domain", func(c *InboundConfig) { c.Domain = "h:p" }, "forbidden"},
		{"missing secret", func(c *InboundConfig) { c.Secret = "" }, "Secret is required"},
		{"secret without ee prefix", func(c *InboundConfig) { c.Secret = "deadbeef" }, "must start with"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := InboundConfig{
				Domain: "www.cloudflare.com",
				Secret: validSecret("www.cloudflare.com"),
			}
			tc.mut(&cfg)
			if err := cfg.validate(); err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("validate: got %v want error containing %q", err, tc.wantErr)
			}
		})
	}
}

func TestInboundDefaults(t *testing.T) {
	cfg := (&InboundConfig{}).withDefaults()
	if cfg.Domain != "www.cloudflare.com" {
		t.Errorf("Domain default: got %q", cfg.Domain)
	}
	if cfg.ListenPort != 443 {
		t.Errorf("ListenPort default: got %d", cfg.ListenPort)
	}
	if cfg.StatsPort != 3129 {
		t.Errorf("StatsPort default: got %d", cfg.StatsPort)
	}
}

func TestRenderConfig_TomlShape_MatchesUpstream(t *testing.T) {
	// Schema verified against 9seconds/mtg/example.config.toml on
	// 2026-05-07. Critical: SINGLE `secret = "..."` (mtg rejects
	// `secrets = [...]` arrays); stats are nested in `[stats.prometheus]`,
	// NOT a flat `stats-bind-to` key.
	domain := "www.cloudflare.com"
	secret := validSecret(domain)
	cfg := InboundConfig{
		Domain: domain, Secret: secret, ListenPort: 443, StatsPort: 3129,
	}
	blob, err := renderConfig(cfg)
	if err != nil {
		t.Fatalf("renderConfig: %v", err)
	}
	out := string(blob)

	for _, want := range []string{
		`secret = "` + secret + `"`,
		`bind-to = "0.0.0.0:443"`,
		`prefer-ip = "prefer-ipv4"`,
		`[stats.prometheus]`,
		`enabled = true`,
		`bind-to = "127.0.0.1:3129"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing fragment %q in render:\n%s", want, out)
		}
	}

	// Anti-regression: must NOT emit the array form mtg rejects, nor the
	// flat stats key from an earlier broken iteration.
	for _, banned := range []string{
		`secrets = [`,
		`stats-bind-to = "`,
		`network-timeout = "`,
	} {
		if strings.Contains(out, banned) {
			t.Errorf("forbidden fragment %q in render (upstream schema mismatch):\n%s", banned, out)
		}
	}
}

func TestRenderConfig_RequiresSecret(t *testing.T) {
	_, err := renderConfig(InboundConfig{Domain: "www.cloudflare.com"})
	if err == nil || !strings.Contains(err.Error(), "Secret is required") {
		t.Errorf("expected Secret-required error, got %v", err)
	}
}
