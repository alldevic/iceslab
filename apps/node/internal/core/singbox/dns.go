package singbox

import (
	"encoding/json"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// The node's resolver (dto.DnsCfg) as sing-box's top-level `dns` block.
//
// What the core does with it was measured, not read (19.13, stand). The name a
// client asks the node to connect to is resolved by the `direct` outbound, and
// the outbound only goes through `dns.rules` when it names no server of its
// own: a `domain_resolver` (18.5's local `egress-dns`) or a
// `route.default_domain_resolver` bypasses the rules and that server answers.
// Dropping them is no way out: with more than one server in `dns`, an outbound
// with no resolver is refused by `sing-box check` (deprecated since 1.12, gone
// in 1.14). What does go through the rules is the route action `resolve`
// without a server: it resolves the destination by DNS routing before the
// outbound dials, and the outbound then has an address. So a node resolver
// adds that rule and a default resolver for the check, and leaves the outbound
// as 18.5 drew it.

// dnsTag is the tag of the n-th (1-based) server of the operator's setting.
func dnsTag(n int) string { return "node-dns-" + strconv.Itoa(n) }

// nodeDNS translates the setting. Nil when nothing in it can be executed; notes
// say, one line each, what was left out and why (the caller puts them in the
// journal, ApplyDns once per change).
//
// Not expressible, and left out with a note: sets (`geosite:`, `ext:`, ...: the
// node has no rule-set files for sing-box), `expectIps`, the second and later
// general servers (sing-box has no fallback chain between servers), address
// kinds sing-box has no server type for. `skipFallback` needs no field: a name
// a rule sent to a server never falls to the general one here.
func nodeDNS(cfg *dto.DnsCfg, ipv6 bool) (*sbDNS, []string) {
	if cfg == nil {
		return nil, nil
	}
	var notes []string
	out := &sbDNS{}
	var rules []sbDNSRule
	final := ""
	for i, s := range cfg.Servers {
		srv, reason := dnsServer(s.Address)
		if reason != "" {
			notes = append(notes, "server "+strconv.Itoa(i+1)+" ("+s.Address+") skipped: "+reason)
			continue
		}
		var matched []sbDNSRule
		if len(s.Domains) > 0 {
			var left []string
			matched, left = domainRules(s.Domains)
			if len(left) > 0 {
				notes = append(notes, "server "+strconv.Itoa(i+1)+" ("+s.Address+"): names not executed on sing-box: "+strings.Join(left, ", "))
			}
			if len(matched) == 0 {
				notes = append(notes, "server "+strconv.Itoa(i+1)+" ("+s.Address+") skipped: none of its names can be matched here")
				continue
			}
		} else if final != "" {
			notes = append(notes, "server "+strconv.Itoa(i+1)+" ("+s.Address+") skipped: sing-box has one general server, "+final+" answers")
			continue
		}
		if len(s.ExpectIPs) > 0 {
			notes = append(notes, "server "+strconv.Itoa(i+1)+" ("+s.Address+"): expectIps not enforced on sing-box")
		}
		srv.Tag = dnsTag(i + 1)
		out.Servers = append(out.Servers, srv)
		if len(s.Domains) == 0 {
			final = srv.Tag
			continue
		}
		for _, r := range matched {
			r.Action, r.Server = "route", srv.Tag
			rules = append(rules, r)
		}
	}
	if len(out.Servers) == 0 {
		return nil, notes
	}
	// The host's own resolver answers what no rule and no general server took,
	// as it does on a node with no setting, and bootstraps servers given by name.
	out.Servers = append(out.Servers, sbDNSServer{Type: "local", Tag: egressDNSTag})
	for i := range out.Servers {
		if out.Servers[i].needsBootstrap {
			out.Servers[i].DomainResolver = &sbDomainResolver{Server: egressDNSTag}
		}
	}
	if final == "" {
		final = egressDNSTag
	}
	out.Rules, out.Final = rules, final
	switch cfg.QueryStrategy {
	case "UseIPv4":
		out.Strategy = "ipv4_only"
	case "UseIPv6":
		out.Strategy = "ipv6_only"
	default:
		// 18.5's prefer_ipv6 is on the outbound, which the resolve rule
		// precedes: the same preference has to be the section's default.
		if ipv6 {
			out.Strategy = "prefer_ipv6"
		}
	}
	out.DisableCache = cfg.DisableCache
	return out, notes
}

type sbDNSRule struct {
	Domain        []string `json:"domain,omitempty"`
	DomainSuffix  []string `json:"domain_suffix,omitempty"`
	DomainKeyword []string `json:"domain_keyword,omitempty"`
	DomainRegex   []string `json:"domain_regex,omitempty"`
	Action        string   `json:"action"`
	Server        string   `json:"server"`
}

// domainRules reads the panel's spelling of names. A bare name is a suffix
// (`domain:`, as the panel itself compares them); `full:` is the exact name.
// Sets stay in left.
func domainRules(domains []string) (rules []sbDNSRule, left []string) {
	var suffix, full, keyword, regex []string
	for _, d := range domains {
		kind, v, _ := strings.Cut(d, ":")
		switch strings.ToLower(kind) {
		case "domain":
			suffix = append(suffix, v)
		case "full":
			full = append(full, v)
		case "keyword":
			keyword = append(keyword, v)
		case "regexp":
			regex = append(regex, v)
		case "geosite", "ext", "ext-domain", "dotless":
			left = append(left, d)
		default:
			if strings.Contains(d, ":") || d == "" {
				left = append(left, d)
			} else {
				suffix = append(suffix, d)
			}
		}
	}
	// One rule per kind: the kinds inside one sing-box rule are ANDed.
	if len(suffix) > 0 {
		rules = append(rules, sbDNSRule{DomainSuffix: suffix})
	}
	if len(full) > 0 {
		rules = append(rules, sbDNSRule{Domain: full})
	}
	if len(keyword) > 0 {
		rules = append(rules, sbDNSRule{DomainKeyword: keyword})
	}
	if len(regex) > 0 {
		rules = append(rules, sbDNSRule{DomainRegex: regex})
	}
	return rules, left
}

// dnsServer maps one address to a server. reason is non-empty when sing-box has
// no server for it. DnsSchema takes any string up to 253 characters, so this is
// where the odd ones are told apart.
func dnsServer(addr string) (srv sbDNSServer, reason string) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return srv, "empty address"
	}
	if strings.EqualFold(addr, "localhost") {
		return sbDNSServer{Type: "local"}, ""
	}
	if !strings.Contains(addr, "://") {
		host, port := hostPortOf(addr, 53)
		if net.ParseIP(host) == nil {
			return srv, "neither an IP address nor a URL sing-box has a server for"
		}
		return withHost(sbDNSServer{Type: "udp"}, host, port, 53), ""
	}
	u, err := url.Parse(addr)
	if err != nil || u.Hostname() == "" {
		return srv, "not an address"
	}
	scheme := strings.TrimSuffix(strings.ToLower(u.Scheme), "+local")
	def := 0
	typ := ""
	switch scheme {
	case "udp":
		typ, def = "udp", 53
	case "tcp":
		typ, def = "tcp", 53
	case "tls":
		typ, def = "tls", 853
	case "https":
		typ, def = "https", 443
	case "h3":
		typ, def = "h3", 443
	case "quic":
		typ, def = "quic", 853
	default:
		return srv, "kind " + u.Scheme + "://, which sing-box has no server for"
	}
	srv = sbDNSServer{Type: typ}
	if typ == "https" || typ == "h3" {
		if p := u.EscapedPath(); p != "" && p != "/dns-query" {
			srv.Path = p
		}
	}
	port := def
	if p := u.Port(); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			port = n
		}
	}
	return withHost(srv, u.Hostname(), port, def), ""
}

func withHost(srv sbDNSServer, host string, port, def int) sbDNSServer {
	srv.Server = host
	if port != def {
		srv.ServerPort = port
	}
	srv.needsBootstrap = net.ParseIP(host) == nil
	return srv
}

// hostPortOf splits "ip", "ip:port" and "[v6]:port"; a bare v6 stays whole.
func hostPortOf(s string, def int) (string, int) {
	if net.ParseIP(s) != nil {
		return s, def
	}
	h, p, err := net.SplitHostPort(s)
	if err != nil {
		return s, def
	}
	n, err := strconv.Atoi(p)
	if err != nil {
		return "", 0
	}
	return h, n
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

// withNodeDNS puts the node's resolver into a rendered config: the section and
// the route rule that sends destination names through it. The one place
// the six render functions and the multi-inbound merge all go through
// (Adapter.render): the base shapes stay as they are, and a node with no
// setting never gets here.
func (a *Adapter) withNodeDNS(blob []byte) ([]byte, error) {
	a.mu.Lock()
	cfg := a.dns
	a.mu.Unlock()
	section, _ := nodeDNS(cfg, nodeHasIPv6())
	if section == nil {
		return blob, nil
	}
	var doc map[string]any
	if err := json.Unmarshal(blob, &doc); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(section)
	if err != nil {
		return nil, err
	}
	var dns any
	if err := json.Unmarshal(raw, &dns); err != nil {
		return nil, err
	}
	doc["dns"] = dns
	// No render function draws a route (a cascade entry's is made after this).
	doc["route"] = map[string]any{
		"default_domain_resolver": map[string]any{"server": egressDNSTag},
		"rules":                   []any{map[string]any{"action": "resolve"}},
	}
	return json.MarshalIndent(doc, "", "  ")
}
