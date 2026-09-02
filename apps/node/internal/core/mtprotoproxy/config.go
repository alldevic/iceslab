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
// secret, with per-user expiry, data quota, connection cap, and Prometheus
// metrics carrying a `user` label. That is what makes MTProto expressible as a
// tariff line rather than a shared password.
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
// option defaults at :190-:295, and the enforcement at :1700-:1713.
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

	// ExpiresAt zero means no expiry. Granularity is a DAY: mtprotoproxy parses
	// USER_EXPIRATIONS with "%d/%m/%Y" and compares `now > expiration`, so the
	// cut lands at 00:00 of that date. See renderConfig for which way we round
	// and why.
	ExpiresAt time.Time

	// QuotaBytes zero means unlimited. Counted as
	// octets_to_client + octets_from_client, i.e. BOTH directions
	// (mtprotoproxy.py:1710).
	QuotaBytes int64

	// MaxConns zero means unlimited, and the panel leaves it that way on
	// purpose.
	//
	// It reads like a device limit and is not one: it caps CONCURRENT TCP
	// connections (`curr_connects`, mtprotoproxy.py:1693), and one Telegram
	// client holds several at once — a main DC, a media DC, more while a file
	// is moving. So mapping a buyer's device allowance onto it 1:1 would
	// disconnect people who are inside their plan, and no honest multiplier
	// suggests itself: upstream documents none, and the real number depends on
	// what the client is doing.
	//
	// A cap that cuts paying users is worse than no cap, so the panel sends
	// none. The field stays supported for an operator who sets one deliberately
	// with a number they have measured.
	MaxConns int
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
// This is what makes the switch seamless. A `tg://` link is not a subscription:
// the client stored a server, a port and a secret, and there is nothing for it
// to re-fetch. Every buyer who ever added the MTProto proxy has mtg's ONE
// shared secret saved in their Telegram. Handed back to mtprotoproxy as a user,
// the FakeTLS string it rebuilds is byte-identical, so those saved links keep
// working while personal ones are handed out beside them.
//
// Returns "" when the secret is not the expected shape, or when its embedded
// domain is not the one this inbound serves — such a secret could not have been
// accepted anyway, and accepting the mismatch would create a user nobody can
// use while looking like migration cover.
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

	// ListenPort is the public TCP port. Default 443.
	ListenPort int

	// MetricsPort is the loopback Prometheus port. Zero disables metrics
	// entirely (METRICS_PORT = None), which also means no per-user accounting —
	// the whole reason this engine exists. The adapter defaults it rather than
	// leaving it off.
	MetricsPort int

	// FastMode pins mtprotoproxy's FAST_MODE. Nil leaves the key out of the
	// generated config, which is upstream's default of True.
	//
	// What the flag does (mtprotoproxy.py:1645-1668): with it on, the proxy
	// hands the CLIENT's key material to the Telegram connection and then
	// replaces its own tg-side decryptor and client-side encryptor with
	// pass-throughs, so bytes coming back from Telegram are relayed to the
	// client without being decrypted and re-encrypted. Off, every byte is
	// re-encrypted by the proxy, which is what mtg does.
	//
	// It is a field rather than a constant because the tg→client direction is
	// exactly the one that failed on this deployment 2026-09-02 — 284
	// connections, no rejected handshake, no timeout, and 1.1 MB delivered —
	// and the only way to tell whether that path is the cause is to run the
	// same traffic with it off. Nil vs false matters here: nil reproduces the
	// failed run byte for byte, false is the experiment.
	FastMode *bool
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
		out.MetricsPort = 3129
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
		return fmt.Errorf("user %q: QuotaBytes is negative", u.Name)
	}
	if u.MaxConns < 0 {
		return fmt.Errorf("user %q: MaxConns is negative", u.Name)
	}
	return nil
}

// renderConfig produces the `config.py` mtprotoproxy executes.
//
// Users are emitted in NAME ORDER, not map order, so the same set renders the
// same bytes. That is what lets the adapter skip a reload when nothing actually
// changed — Go map iteration is randomised, and without the sort every push
// would look like a change and SIGUSR2 the process.
//
// EXPIRY ROUNDING. USER_EXPIRATIONS has day granularity and cuts at 00:00 of
// the named date, so a user whose subscription ends at 15:35 today would be cut
// ~16 hours early if we wrote today's date. We write the day AFTER, which
// leaves at most a day of grace, because the precise cut is the PANEL's job:
// an expired user stops being pushed and is removed by RemoveUser. This field
// is the backstop for the window where the panel cannot reach the node, and a
// backstop that fires early takes the channel from someone who paid for it.
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
		d := u.ExpiresAt.UTC().AddDate(0, 0, 1)
		return fmt.Sprintf("%q", d.Format("02/01/2006")), true
	})
	writeSection(&b, "USER_DATA_QUOTA", sorted, func(u User) (string, bool) {
		if u.QuotaBytes <= 0 {
			return "", false
		}
		return fmt.Sprintf("%d", u.QuotaBytes), true
	})
	writeSection(&b, "USER_MAX_TCP_CONNS", sorted, func(u User) (string, bool) {
		if u.MaxConns <= 0 {
			return "", false
		}
		return fmt.Sprintf("%d", u.MaxConns), true
	})

	// Loopback only. The BIND is the access control: a socket bound to
	// 127.0.0.1 cannot be reached from off the host, whatever the whitelist
	// says. The whitelist is a second gate on top of it, and it is the one that
	// has to know something about this machine.
	//
	// It lists 127.0.0.1 plus every address this node itself carries, because a
	// connection to a loopback-bound socket CAN arrive with a non-loopback
	// source. Measured on a fleet node 2026-09-02: the WireGuard bootstrap had
	// left `-A POSTROUTING ! -o awg0 -j MASQUERADE`, and `! -o awg0` matches
	// every interface including `lo`, so a scrape of 127.0.0.1:3130 arrived
	// with the node's public address. mtprotoproxy compares the source against
	// this list and closes the connection without a byte when it misses — no
	// error, no log line, just an endpoint that answers nothing. The engine
	// exists for its per-user numbers, so that silence is the whole feature
	// gone.
	//
	// Listing the node's own addresses gives up nothing: they are the only
	// sources a loopback-bound socket can see.
	fmt.Fprintf(&b, "METRICS_PORT = %d\n", cfg.MetricsPort)
	b.WriteString("METRICS_LISTEN_ADDR_IPV4 = \"127.0.0.1\"\n")
	b.WriteString("METRICS_LISTEN_ADDR_IPV6 = None\n")
	fmt.Fprintf(&b, "METRICS_WHITELIST = [%s]\n", pyStringList(metricsWhitelist()))
	// The links carry every user's secret. The scraper is ours and does not
	// need them, and a metrics endpoint that hands out working proxy links is
	// a credential store with no authentication in front of it.
	b.WriteString("METRICS_EXPORT_LINKS = False\n")

	// Written only when pinned. An absent key is upstream's own default, and
	// writing it out anyway would make a config that changes meaning if
	// upstream ever changes that default look like a config we chose.
	if cfg.FastMode != nil {
		fmt.Fprintf(&b, "FAST_MODE = %s\n", pyBool(*cfg.FastMode))
	}

	return []byte(b.String()), nil
}

// pyBool renders a Go bool as the Python literal, since the config file is
// executed as Python and `true` is a NameError there, not a value.
func pyBool(v bool) string {
	if v {
		return "True"
	}
	return "False"
}

// writeSection emits `NAME = {...}` over the users for which `value` returns a
// value, or nothing at all when none do — an empty dict and an absent key mean
// the same to mtprotoproxy (`setdefault`), and omitting keeps the file readable.
func writeSection(b *strings.Builder, name string, users []User, value func(User) (string, bool)) {
	var rows []string
	for _, u := range users {
		if v, ok := value(u); ok {
			rows = append(rows, fmt.Sprintf("    %q: %s,\n", u.Name, v))
		}
	}
	if len(rows) == 0 {
		return
	}
	fmt.Fprintf(b, "%s = {\n", name)
	for _, r := range rows {
		b.WriteString(r)
	}
	b.WriteString("}\n\n")
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

// metricsWhitelist is 127.0.0.1 plus every unicast address this node carries.
// See the comment at its call site for why the node's own addresses belong
// there. Failure to enumerate falls back to loopback alone: that is the shape
// that works on a host which does not rewrite loopback sources, and a wrong
// guess here is better than a wide list.
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
		// IPv4 only: METRICS_LISTEN_ADDR_IPV6 is None above, so the socket
		// cannot be reached over IPv6 and an IPv6 source is impossible. Listing
		// them would only widen the list with addresses that can never appear —
		// on a box with several interfaces that is a dozen link-local entries
		// nobody can read past.
		v4 := ipnet.IP.To4()
		if v4 == nil {
			continue
		}
		ip := v4.String()
		if seen[ip] {
			continue
		}
		seen[ip] = true
		out = append(out, ip)
	}
	sort.Strings(out)
	return out
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
