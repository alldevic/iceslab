package hysteria

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// The node's resolver (dto.DnsCfg) as hysteria's `resolver:` section.
//
// What the core can do (19.14; hysteria 2.12.3, app/cmd/server.go
// serverConfigResolver*, and the live test in dns_live_test.go): ONE resolver
// per server, of kind udp, tcp, tls (DoT) or https (DoH, the path is fixed at
// /dns-query), used by the `direct` outbound to resolve the names clients ask
// for. No choice by domain, no second server, no fallback, no query strategy
// (the address family is the outbound's `mode`, 18.5). So the only part of the
// setting this core executes is a general server; a setting with servers that
// carry domains is executed in part, which the node reports as not executed
// (ExecutesDns) rather than inventing a third state.

// resolver is the section: Type names the kind, Addr is host:port, SNI is set
// for tls and https when Addr names a host and not an IP.
type resolver struct {
	Type string
	Addr string
	SNI  string
}

// nodeResolver translates the setting. res is nil when nothing is to be drawn;
// executed is true only when the whole setting is carried out: it has no
// server with domains and a general server could be translated (or asks for the
// host's own resolver, which is what no section does). notes say, one line
// each, what was left out and why.
//
// The general server is the first one without domains that has a kind this
// core has. When a setting also has servers with domains, the general one is
// still drawn: it answers the names no rule was written for, as on the other
// cores, and the node says it executes only a part.
func nodeResolver(cfg *dto.DnsCfg) (res *resolver, executed bool, notes []string) {
	if cfg == nil {
		return nil, true, nil
	}
	hasDomains, chosen := false, false
	for i, s := range cfg.Servers {
		label := "server " + strconv.Itoa(i+1) + " (" + s.Address + ")"
		if len(s.Domains) > 0 {
			hasDomains = true
			notes = append(notes, label+" skipped: hysteria cannot choose a resolver by domain")
			continue
		}
		if chosen {
			notes = append(notes, label+" skipped: hysteria has one resolver, the first general server answers")
			continue
		}
		r, _, reason := hysteriaServer(s.Address)
		if reason != "" {
			notes = append(notes, label+" skipped: "+reason)
			continue
		}
		chosen, res = true, r
		if len(s.ExpectIPs) > 0 {
			notes = append(notes, label+": expectIps not enforced on hysteria")
		}
	}
	if chosen && (cfg.QueryStrategy == "UseIPv4" || cfg.QueryStrategy == "UseIPv6" || cfg.DisableCache) {
		notes = append(notes, "queryStrategy and disableCache are not expressible on hysteria")
	}
	return res, chosen && !hasDomains, notes
}

// hysteriaServer maps one address to the resolver. local: the address asks for
// the host's own resolver, which is what hysteria uses with no section. reason
// is non-empty when hysteria has no resolver for the address.
func hysteriaServer(addr string) (r *resolver, local bool, reason string) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return nil, false, "empty address"
	}
	if strings.EqualFold(addr, "localhost") {
		return nil, true, ""
	}
	if !strings.Contains(addr, "://") {
		host, port, ok := splitHostPort(addr, 53)
		if !ok || net.ParseIP(host) == nil {
			return nil, false, "neither an IP address nor a URL hysteria has a resolver for"
		}
		return &resolver{Type: "udp", Addr: net.JoinHostPort(host, strconv.Itoa(port))}, false, ""
	}
	u, err := url.Parse(addr)
	if err != nil || u.Hostname() == "" {
		return nil, false, "not an address"
	}
	typ, def := "", 0
	switch strings.TrimSuffix(strings.ToLower(u.Scheme), "+local") {
	case "udp":
		typ, def = "udp", 53
	case "tcp":
		typ, def = "tcp", 53
	case "tls":
		typ, def = "tls", 853
	case "https":
		typ, def = "https", 443
		if p := u.EscapedPath(); p != "" && p != "/" && p != "/dns-query" {
			return nil, false, "hysteria's DoH resolver asks /dns-query only, not " + p
		}
	default:
		return nil, false, "kind " + u.Scheme + "://, which hysteria has no resolver for"
	}
	port := def
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return nil, false, "not a port: " + p
		}
		port = n
	}
	r = &resolver{Type: typ, Addr: net.JoinHostPort(u.Hostname(), strconv.Itoa(port))}
	if (typ == "tls" || typ == "https") && net.ParseIP(u.Hostname()) == nil {
		r.SNI = u.Hostname()
	}
	return r, false, ""
}

// splitHostPort splits "ip", "ip:port" and "[v6]:port"; a bare v6 stays whole.
func splitHostPort(s string, def int) (string, int, bool) {
	if net.ParseIP(s) != nil {
		return s, def, true
	}
	h, p, err := net.SplitHostPort(s)
	if err != nil {
		return "", 0, false
	}
	n, err := strconv.Atoi(p)
	if err != nil || n < 1 || n > 65535 {
		return "", 0, false
	}
	return h, n, true
}

// writeResolver appends the section; nil writes nothing. The values come from
// the panel, so they are held to the same rule as every pushed string.
func writeResolver(b *bytes.Buffer, r *resolver) error {
	if r == nil {
		return nil
	}
	// Host and port only: ':' is the one char an address has to carry (and '['
	// for IPv6), and they go in quotes below.
	for _, v := range []string{r.Addr, r.SNI} {
		if strings.ContainsAny(v, "\n\r\"\\#{}") {
			return fmt.Errorf("hysteria resolver: disallowed char in %q", v)
		}
	}
	b.WriteString("\nresolver:\n")
	fmt.Fprintf(b, "  type: %s\n", r.Type)
	fmt.Fprintf(b, "  %s:\n", r.Type)
	fmt.Fprintf(b, "    addr: \"%s\"\n", r.Addr)
	if r.SNI != "" {
		fmt.Fprintf(b, "    sni: \"%s\"\n", r.SNI)
	}
	return nil
}

// sameDns compares two settings by their wire form: the structs carry slices,
// and a push repeating the setting has to be a no-op rather than a restart.
func sameDns(a, b *dto.DnsCfg) bool {
	if a == nil || b == nil {
		return a == b
	}
	ja, errA := json.Marshal(a)
	jb, errB := json.Marshal(b)
	return errA == nil && errB == nil && string(ja) == string(jb)
}

// ApplyDns implements core.DnsReceiver: keep the node's resolver and re-render
// if it changed. What of it the core carries out is told by ExecutesDns.
//
// Like ApplyCascade: with no inbound yet (or nothing to write to) the setting
// is only remembered; a render that fails does not become the state; a setting
// repeated is a no-op, or every push would restart the core and drop every
// live connection. Absent is a state: it is how a resolver is taken off.
func (a *Adapter) ApplyDns(raw json.RawMessage) error {
	var parsed *dto.DnsCfg
	if len(raw) > 0 && string(raw) != "null" {
		var decoded dto.DnsCfg
		if err := json.Unmarshal(raw, &decoded); err != nil {
			return fmt.Errorf("hysteria ApplyDns: %w", err)
		}
		if len(decoded.Servers) == 0 {
			return fmt.Errorf("hysteria ApplyDns: a dns section with no servers")
		}
		parsed = &decoded
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	if sameDns(a.dns, parsed) && !a.coreDownLocked() && !a.familyStaleLocked() {
		return nil
	}
	res, executed, notes := nodeResolver(parsed)
	for _, n := range notes {
		a.logger.Warn("hysteria ApplyDns: " + n)
	}
	if parsed != nil && !executed {
		a.logger.Warn("hysteria ApplyDns: the resolver is not carried out in full, the node reports it as not executed", "section", res != nil)
	}
	if a.inbound == (InboundConfig{}) || a.cfg.ConfigPath == "" {
		a.dns = parsed
		return nil
	}
	// A setting that draws the same section as the one on disk (a rule
	// added to a node that has none for it) still restarts nothing: the file
	// would be byte-identical.
	prevRes, _, _ := nodeResolver(a.dns)
	if a.chain != nil {
		prevRes, res = nil, nil // a hand-off draws no resolver
	}
	if (prevRes == nil) == (res == nil) && (res == nil || *prevRes == *res) && !a.coreDownLocked() && !a.familyStaleLocked() {
		a.dns = parsed
		return nil
	}
	// Rendered BEFORE it is stored, as the hand-off is.
	if err := a.rewriteWithLocked(a.inbound, a.chain, res, "ApplyDns"); err != nil {
		return err
	}
	a.dns = parsed
	a.logger.Info("hysteria ApplyDns: resolver changed", "named", parsed != nil, "section", res != nil, "path", a.cfg.ConfigPath)
	return a.restartLocked("ApplyDns")
}

// ExecutesDns implements core.DnsExecutionReporter: whether the setting held
// now is carried out in full. True with none held (nothing is left undone);
// false when it has servers by domain, which this core cannot choose by, or no
// general server this core has a resolver for.
func (a *Adapter) ExecutesDns() bool {
	a.mu.RLock()
	cfg := a.dns
	a.mu.RUnlock()
	_, executed, _ := nodeResolver(cfg)
	return executed
}
