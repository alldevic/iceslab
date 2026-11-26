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
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

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

	// ExpiresAt zero means no term. In the roster it is the user's exact term,
	// which the adapter enforces itself (a user past it is left out of the
	// config); in the file it becomes USER_EXPIRATIONS, the coarse backstop.
	// See expirationDate.
	ExpiresAt time.Time

	// Limited says whether the user has a traffic limit at all; QuotaBytes is
	// meaningful only then, and 0 is a limit spent, not "no limit". In the
	// adapter's roster QuotaBytes is the REMAINDER the panel pushed; renderConfig
	// receives the number the engine compares against its own counter (the
	// adapter has added the counter to the remainder by then). Counted as
	// octets_to_client + octets_from_client, both directions
	// (mtprotoproxy.py:1710).
	Limited    bool
	QuotaBytes int64
}

// sameAs: the pushed facts of two users are the same. time.Time is compared by
// instant, not by == (zone pointer and monotonic reading are not facts).
func (u User) sameAs(o User) bool {
	return u.Name == o.Name && u.Secret == o.Secret && u.ExpiresAt.Equal(o.ExpiresAt) &&
		u.Limited == o.Limited && u.QuotaBytes == o.QuotaBytes
}

// expirationDate is the value of USER_EXPIRATIONS for a term. mtprotoproxy
// parses it with "%d/%m/%Y" and cuts the user off when its local time is past
// 00:00 of that date (`now > expiration`, naive local datetimes), so the date
// must be the local day AFTER the term in the node's own zone: 00:00 of it is
// never before the term. The fork formatted in UTC, which on a node west of
// UTC cut the user off hours before the term. The exact cut-off is the
// adapter's (it drops the user at the instant); this date is only the net
// under it.
func expirationDate(t time.Time, loc *time.Location) string {
	return t.In(loc).AddDate(0, 0, 1).Format("02/01/2006")
}

// LegacyUserName is the name the mtg-era shared secret is carried under while
// a node is being migrated.
//
// It is deliberately not a panel user id: nobody owns this secret, everybody
// who ever got an mtg link has it. Traffic under this name is what has NOT
// migrated yet, and watching it fall to zero on the metrics endpoint is how an
// operator knows the legacy secret can be dropped.
const LegacyUserName = "legacy-mtg"

// legacyRawSecret pulls the 16 raw bytes out of an mtg FakeTLS secret
// (`ee` + 32 hex + hex(domain)) so mtprotoproxy can accept it as a user.
//
// A `tg://` link is not a subscription: the client stored a server, a port and
// a secret, and there is nothing for it to re-fetch. Every buyer who ever added
// the MTProto proxy has mtg's ONE shared secret saved in their Telegram. Handed
// back to mtprotoproxy as a user, the FakeTLS string it rebuilds is
// byte-identical, so those saved links keep working while personal ones are
// handed out beside them.
//
// Returns "" when the secret is not the expected shape, or when its embedded
// domain is not the one this inbound serves: such a secret could not have been
// accepted anyway, and carrying it would create a user nobody can use while
// looking like migration cover.
func legacyRawSecret(mtgSecret, domain string) string {
	if len(mtgSecret) < 34 || mtgSecret[:2] != "ee" {
		return ""
	}
	raw := mtgSecret[2:34]
	for _, ch := range raw {
		if !isHex(ch) {
			return ""
		}
	}
	if mtgSecret[34:] != hex.EncodeToString([]byte(domain)) {
		return ""
	}
	return raw
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

	// zone is the node's time zone, the one mtprotoproxy reads USER_EXPIRATIONS
	// in; nil → time.Local (what the engine's own process sees). Tests set it
	// rather than the process-wide time.Local.
	zone *time.Location
}

func (c InboundConfig) zoneOrLocal() *time.Location {
	if c.zone != nil {
		return c.zone
	}
	return time.Local
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
	if u.QuotaBytes < 0 {
		return fmt.Errorf("user %q: quota must not be negative, got %d", u.Name, u.QuotaBytes)
	}
	if !u.ExpiresAt.IsZero() {
		if y := u.ExpiresAt.Year(); y < 1970 || y > 9999 {
			return fmt.Errorf("user %q: expiry year out of range: %d", u.Name, y)
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

	writeSection(&b, "USER_EXPIRATIONS", sorted, func(u User) (string, bool) {
		if u.ExpiresAt.IsZero() {
			return "", false
		}
		d := expirationDate(u.ExpiresAt, cfg.zoneOrLocal())
		// The same alphabet discipline as everything else in this file: only
		// digits and slashes may come out of a date.
		for _, ch := range d {
			if !(ch >= '0' && ch <= '9') && ch != '/' {
				return "", false
			}
		}
		return fmt.Sprintf("%q", d), true
	})
	writeSection(&b, "USER_DATA_QUOTA", sorted, func(u User) (string, bool) {
		if !u.Limited {
			return "", false
		}
		return fmt.Sprintf("%d", u.QuotaBytes), true
	})

	// Loopback only, and the whitelist is spelled out rather than left to the
	// default: this endpoint names every user and their traffic.
	fmt.Fprintf(&b, "METRICS_PORT = %d\n", cfg.MetricsPort)
	b.WriteString("METRICS_LISTEN_ADDR_IPV4 = \"127.0.0.1\"\n")
	b.WriteString("METRICS_LISTEN_ADDR_IPV6 = None\n")
	// The whitelist is loopback PLUS this machine's own IPv4 addresses: a
	// connection to a loopback-bound socket arrives with a non-loopback source
	// when the host masquerades its own traffic (the WireGuard/AmneziaWG
	// `! -o awg0 -j MASQUERADE` matches `lo` too), and mtprotoproxy answers a
	// scrape from a source off the list by closing the connection. The socket
	// itself stays bound to 127.0.0.1: nothing off the host can reach it.
	fmt.Fprintf(&b, "METRICS_WHITELIST = [%s]\n", pyStringList(metricsWhitelist()))
	// The links carry every user's secret. The scraper is ours and does not
	// need them, and a metrics endpoint that hands out working proxy links is
	// a credential store with no authentication in front of it.
	b.WriteString("METRICS_EXPORT_LINKS = False\n")

	return []byte(b.String()), nil
}

// writeSection renders `NAME = {...}` for the users that have a value, and
// nothing at all when none does: an absent key is the engine's own default, and
// an empty dict would say the same thing with more to go wrong. Values come back
// already formatted from %q or %d.
func writeSection(b *strings.Builder, name string, users []User, value func(User) (string, bool)) {
	wrote := false
	for _, u := range users {
		v, ok := value(u)
		if !ok {
			continue
		}
		if !wrote {
			fmt.Fprintf(b, "%s = {\n", name)
			wrote = true
		}
		fmt.Fprintf(b, "    %q: %s,\n", u.Name, v)
	}
	if wrote {
		b.WriteString("}\n\n")
	}
}

// metricsWhitelist is 127.0.0.1 plus every IPv4 address this node carries.
// Failure to enumerate falls back to loopback alone, the shape that works on a
// host which does not rewrite loopback sources. IPv6 is left out:
// METRICS_LISTEN_ADDR_IPV6 is None, so an IPv6 source cannot occur. Each entry
// passes the same character allow-list as the other values of this file.
func metricsWhitelist() []string {
	out := []string{"127.0.0.1"}
	seen := map[string]bool{"127.0.0.1": true}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok || ipnet.IP == nil {
			continue
		}
		v4 := ipnet.IP.To4()
		if v4 == nil {
			continue
		}
		ip := v4.String()
		if seen[ip] || !validHostString(ip) {
			continue
		}
		seen[ip] = true
		out = append(out, ip)
	}
	sort.Strings(out)
	return out
}

func validHostString(s string) bool {
	for _, ch := range s {
		if !validHostChar(ch) {
			return false
		}
	}
	return s != ""
}

// pyStringList renders a Go slice as a Python list literal, each element
// through %q so nothing in it can leave its string.
func pyStringList(items []string) string {
	parts := make([]string, 0, len(items))
	for _, s := range items {
		parts = append(parts, fmt.Sprintf("%q", s))
	}
	return strings.Join(parts, ", ")
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
