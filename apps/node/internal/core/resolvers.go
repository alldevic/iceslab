package core

import (
	"net"
	"sort"
	"strconv"
	"sync"
	"time"
)

// The resolvers a core asks when the panel named none (E37, 25.09 on nl-01).
//
// Left to itself a core resolves through the host, which on a systemd host is
// the stub at 127.0.0.53. On nl-01 that stub stopped answering (an AmneziaWG
// MASQUERADE rule rewrote loopback queries to the public address and
// systemd-resolved dropped them), and every host of the core went dead with the
// panel reading ONLINE. Two public resolvers first and the host's own last, so
// any one of the three is enough. `localhost` is how xray names the host's
// resolver; a core that spells it differently maps it.
var DefaultResolvers = []string{"1.1.1.1", "8.8.8.8", "localhost"}

// ResolveStrategy is the one choice of address family a core resolves names
// with, in xray's words: UseIP where the node has global IPv6, UseIPv4
// otherwise. An AAAA answer on a node with no IPv6 is an address the
// connection then fails to dial.
func ResolveStrategy(ipv6 bool) string {
	if ipv6 {
		return "UseIP"
	}
	return "UseIPv4"
}

// HostHasGlobalIPv6: an interface of this host carries a global IPv6 address.
// Link-local and unique-local (fc00::/7) do not count: neither reaches the
// internet.
func HostHasGlobalIPv6() bool {
	return len(HostGlobalIPv6Addrs()) > 0
}

// HostGlobalIPv6Addrs lists the global IPv6 addresses of this host, sorted and
// without duplicates, so the same host always answers the same list.
func HostGlobalIPv6Addrs() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	return globalIPv6From(addrs)
}

func globalIPv6From(addrs []net.Addr) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, a := range addrs {
		n, ok := a.(*net.IPNet)
		if !ok || n.IP.To4() != nil {
			continue
		}
		if n.IP.IsGlobalUnicast() && !n.IP.IsPrivate() && !seen[n.IP.String()] {
			seen[n.IP.String()] = true
			out = append(out, n.IP.String())
		}
	}
	sort.Strings(out)
	return out
}

// CanListenIPv6 is the "stack" fact: a socket on `::` can be bound here AND
// takes IPv4 as well. Both, because a host with net.ipv6.conf.all.disable_ipv6=1
// refuses the bind, and one with bindv6only=1 binds but leaves IPv4 out, and a
// core listening on `::` there would lose its IPv4 clients. The probe binds a
// throwaway port and dials it over 127.0.0.1.
func CanListenIPv6() bool {
	ln, err := net.Listen("tcp", "[::]:0")
	if err != nil {
		return false
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	c, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// IPv6Facts is what the agent reports of the host's IPv6 (the panel's
// NodeIPv6). Egress is not here yet: the outbound check arrives with its own
// milestone, and until then the panel reads its absence as "no".
type IPv6Facts struct {
	Stack     bool
	Global    bool
	Addresses []string
}

// ProbeIPv6 reads the facts once, without a cache.
func ProbeIPv6() IPv6Facts {
	addrs := HostGlobalIPv6Addrs()
	return IPv6Facts{Stack: CanListenIPv6(), Global: len(addrs) > 0, Addresses: addrs}
}

// IPv6Prober answers /healthz from a cached probe: the bind is a syscall pair
// that has no business running on every poll, and an address or a sysctl
// changes on the scale of minutes.
type IPv6Prober struct {
	ttl   time.Duration
	probe func() IPv6Facts
	now   func() time.Time

	mu  sync.Mutex
	at  time.Time
	val IPv6Facts
}

// NewIPv6Prober caches ProbeIPv6 for ttl.
func NewIPv6Prober(ttl time.Duration) *IPv6Prober {
	return &IPv6Prober{ttl: ttl, probe: ProbeIPv6, now: time.Now}
}

// Facts returns the cached facts, probing again once they are older than ttl.
func (p *IPv6Prober) Facts() IPv6Facts {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.at.IsZero() && p.now().Sub(p.at) < p.ttl {
		return p.val
	}
	p.val = p.probe()
	p.at = p.now()
	return p.val
}
