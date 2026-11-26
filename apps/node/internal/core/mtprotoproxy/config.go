// Package mtprotoproxy implements CoreAdapter for Telegram MTProto via
// alexbers/mtprotoproxy — the multi-user alternative to 9seconds/mtg.
//
// WHY A SECOND MTPROTO ENGINE
// ===========================
// mtg is single-secret by design ("multiple secrets solve no problems and just
// complex software" — upstream). One inbound, one secret, shared by everybody
// in the squad. The consequences are not cosmetic:
//
//   - MTProto traffic cannot be attributed to a user, so it cannot be counted;
//   - a disabled, expired or DELETED buyer keeps working forever, as does
//     anyone they forwarded the link to;
//   - the only revocation is rotating the secret, which takes the channel away
//     from every user at once.
//
// alexbers/mtprotoproxy has a user concept: USERS maps a name to its own
// secret, and it exports Prometheus metrics carrying a `user` label. That is
// what makes MTProto expressible as a tariff line rather than a shared
// password.
//
// The adapter is registered under Name()=="mtproto", Engine()=="mtprotoproxy",
// so an inbound picks it with `engine: "mtprotoproxy"` and installations on mtg
// are untouched. Both adapters can be registered at once; the panel's inbound
// decides which one renders it.
//
// THE CONFIG IS EXECUTED PYTHON, NOT A DATA FILE
// ==============================================
// mtprotoproxy loads its config with `runpy.run_path(sys.argv[1])` — it EXECUTES
// the file. mtg's TOML could at worst be broken out of into other TOML keys; a
// break-out here is arbitrary code as root on the node. Every value that reaches
// the file is therefore checked against a strict allow-list alphabet before it
// is written, and numbers go through %d rather than string interpolation. See
// validate() — that is the security boundary of this package, not a formality.
//
// Verified against alexbers/mtprotoproxy master, read 2026-09-02:
// config.py (the shipped example), init_config() at mtprotoproxy.py:101, the
// option defaults at :190-:295.
package mtprotoproxy

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/icecompany-tech/iceslab/apps/node/internal/atomicfile"
)

// User is one MTProto subscriber as mtprotoproxy models it.
type User struct {
	// Name is the key in USERS and the value of the `user` label on every
	// metric. The panel sends the user's id, so metrics attribute straight back
	// without a second lookup.
	Name string

	// Secret is 32 hex chars = the 16 raw bytes Telegram mandates. The client
	// rejects anything longer with "Invalid proxy link" (caught live on iOS
	// 2026-05-13, see the mtg adapter). mtprotoproxy builds the FakeTLS form
	// itself as `"ee" + secret + TLS_DOMAIN.hex()` (mtprotoproxy.py:2189) —
	// byte-identical to what mtg is handed, so the panel's URI builder needs no
	// second spelling.
	Secret string
}

// InboundConfig holds the per-inbound settings.
type InboundConfig struct {
	// Domain is the FakeTLS masquerade target (TLS_DOMAIN).
	Domain string

	// ListenPort is the public TCP port. Zero means 443 here; the agent's own
	// fallback (2084, so it does not meet mtg) is set by main.
	ListenPort int

	// MetricsPort is the loopback Prometheus port. Zero means 3130: mtg keeps
	// 3129, and both engines may stand on one node. The endpoint is always on,
	// since per-user accounting is the reason this engine exists.
	MetricsPort int
}

func (c InboundConfig) withDefaults() InboundConfig {
	out := c
	if out.Domain == "" {
		out.Domain = "www.cloudflare.com"
	}
	if out.ListenPort == 0 {
		out.ListenPort = 443
	}
	if out.MetricsPort == 0 {
		out.MetricsPort = 3130
	}
	return out
}

// hostRe-equivalent, hand-rolled to keep the allow-list obvious at the call
// site: letters, digits, dot, hyphen. No quotes, no backslash, no newline, no
// brace — nothing that can leave a Python string literal.
func validHostChar(ch rune) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
		(ch >= '0' && ch <= '9') || ch == '.' || ch == '-'
}

// A user name becomes a dict key in executed Python and a metric label. Panel
// ids are UUIDs, so hex plus hyphen covers them; underscore is allowed for the
// hand-made names an operator might use.
func validNameChar(ch rune) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
		(ch >= '0' && ch <= '9') || ch == '-' || ch == '_'
}

func isHex(ch rune) bool {
	return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')
}

func (c InboundConfig) validate() error {
	if c.Domain == "" {
		return errors.New("Domain is required")
	}
	for _, ch := range c.Domain {
		if !validHostChar(ch) {
			return fmt.Errorf("Domain has a forbidden char %q in %q", ch, c.Domain)
		}
	}
	if c.ListenPort < 1 || c.ListenPort > 65535 {
		return fmt.Errorf("ListenPort out of range: %d", c.ListenPort)
	}
	if c.MetricsPort < 1 || c.MetricsPort > 65535 {
		return fmt.Errorf("MetricsPort out of range: %d", c.MetricsPort)
	}
	return nil
}

func (u User) validate() error {
	if u.Name == "" {
		return errors.New("user Name is required")
	}
	for _, ch := range u.Name {
		if !validNameChar(ch) {
			return fmt.Errorf("user Name has a forbidden char %q in %q", ch, u.Name)
		}
	}
	// 32 hex chars exactly. Shorter is not padded on purpose: mtprotoproxy's
	// undocumented argv path zfills, but a silently padded secret is a secret
	// the panel did not issue, and the URI the buyer holds would not match.
	if len(u.Secret) != 32 {
		return fmt.Errorf("user %q: Secret must be 32 hex chars, got %d", u.Name, len(u.Secret))
	}
	for _, ch := range u.Secret {
		if !isHex(ch) {
			return fmt.Errorf("user %q: Secret must be hex, got %q", u.Name, ch)
		}
	}
	return nil
}

// renderConfig produces the `config.py` mtprotoproxy executes.
//
// Users are emitted in NAME ORDER, not map order, so the same set renders the
// same bytes. That is what lets the adapter skip a reload when nothing actually
// changed — Go map iteration is randomised, and without the sort every push
// would look like a change and SIGUSR2 the process.
func renderConfig(inbound InboundConfig, users []User) ([]byte, error) {
	// Defaults FIRST, then validate: a zero port means "unset, use the default",
	// and validating before filling them in rejected the very case withDefaults
	// exists for. Caught by TestDefaultsFillIn rather than in the field.
	cfg := inbound.withDefaults()
	if err := cfg.validate(); err != nil {
		return nil, err
	}

	seen := make(map[string]struct{}, len(users))
	sorted := make([]User, 0, len(users))
	for _, u := range users {
		if err := u.validate(); err != nil {
			return nil, err
		}
		// A duplicate name would silently collapse into one dict key, and which
		// secret survived would depend on push order. Refuse instead.
		if _, dup := seen[u.Name]; dup {
			return nil, fmt.Errorf("duplicate user name %q", u.Name)
		}
		seen[u.Name] = struct{}{}
		sorted = append(sorted, u)
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })

	var b strings.Builder
	b.WriteString("# Generated by iceslab-node. Do not edit: rewritten on every push.\n")
	b.WriteString("# mtprotoproxy EXECUTES this file (runpy.run_path), so every value\n")
	b.WriteString("# here passed an allow-list check in config.go before being written.\n\n")

	fmt.Fprintf(&b, "PORT = %d\n\n", cfg.ListenPort)

	// USERS may legitimately be empty: an inbound with no assigned users should
	// listen and refuse everyone, not fail to start.
	b.WriteString("USERS = {\n")
	for _, u := range sorted {
		fmt.Fprintf(&b, "    %q: %q,\n", u.Name, u.Secret)
	}
	b.WriteString("}\n\n")

	// FakeTLS only. `classic` and `secure` are the detectable modes, and this
	// deployment has always presented as TLS to a cover domain; offering the
	// weaker ones would be a downgrade nobody asked for.
	b.WriteString("MODES = {\n")
	b.WriteString("    \"classic\": False,\n")
	b.WriteString("    \"secure\": False,\n")
	b.WriteString("    \"tls\": True,\n")
	b.WriteString("}\n\n")

	fmt.Fprintf(&b, "TLS_DOMAIN = %q\n\n", cfg.Domain)

	// Loopback only, and the whitelist is spelled out rather than left to the
	// default: this endpoint names every user and their traffic.
	fmt.Fprintf(&b, "METRICS_PORT = %d\n", cfg.MetricsPort)
	b.WriteString("METRICS_LISTEN_ADDR_IPV4 = \"127.0.0.1\"\n")
	b.WriteString("METRICS_LISTEN_ADDR_IPV6 = None\n")
	b.WriteString("METRICS_WHITELIST = [\"127.0.0.1\"]\n")
	// The links carry every user's secret. The scraper is ours and does not
	// need them, and a metrics endpoint that hands out working proxy links is
	// a credential store with no authentication in front of it.
	b.WriteString("METRICS_EXPORT_LINKS = False\n")

	return []byte(b.String()), nil
}

// writeConfig atomically writes config.py. Mode 0600: the file lists every
// user's secret.
func writeConfig(path string, blob []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	return atomicfile.Write(path, blob, 0o600)
}
