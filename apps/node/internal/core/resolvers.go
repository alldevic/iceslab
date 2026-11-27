package core

import (
	"context"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
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

// IPv6EgressTargetsEnv is the agent env key that names the addresses the
// egress check dials: a comma list of host:port, an IPv6 literal in brackets
// ("[2606:4700:4700::1111]:443"). Empty or unset means the default pair.
const IPv6EgressTargetsEnv = "IPV6_EGRESS_PROBE_TARGETS"

// DefaultIPv6EgressTargets are the Cloudflare and Google public resolvers over
// IPv6, port 443: two operators, so one being unreachable from a network does
// not read as "no IPv6".
var DefaultIPv6EgressTargets = []string{"[2606:4700:4700::1111]:443", "[2001:4860:4860::8888]:443"}

const ipv6EgressTimeout = 3 * time.Second

// IPv6EgressTargets parses the env value; an empty list falls back to the
// defaults.
func IPv6EgressTargets(env string) []string {
	var out []string
	for _, t := range strings.Split(env, ",") {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return append([]string(nil), DefaultIPv6EgressTargets...)
	}
	return out
}

// dialFunc is net.Dialer.DialContext, swapped in tests.
type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// IPv6EgressWorks: a TCP connection to any one target succeeds over an IPv6
// socket. "tcp6", never "tcp": a dial that may fall back to IPv4 would report a
// working IPv6 on a host that has only IPv4. Targets are asked at once, so one
// dead address costs no more than the timeout.
func IPv6EgressWorks(targets []string, dial dialFunc, timeout time.Duration) bool {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	ok := make(chan bool, len(targets))
	for _, t := range targets {
		go func(addr string) {
			c, err := dial(ctx, "tcp6", addr)
			if err == nil {
				c.Close()
			}
			ok <- err == nil
		}(t)
	}
	for range targets {
		if <-ok {
			return true
		}
	}
	return false
}

// IPv6Facts is what the agent reports of the host's IPv6 (the panel's
// NodeIPv6). Egress: an outbound IPv6 connection went through at the last
// check; false also where there is no global address to try from.
type IPv6Facts struct {
	Stack     bool
	Global    bool
	Egress    bool
	Addresses []string
}

// ProbeIPv6 reads the facts once, without a cache. The egress check runs only
// from a host that has a global address.
func ProbeIPv6() IPv6Facts {
	addrs := HostGlobalIPv6Addrs()
	f := IPv6Facts{Stack: CanListenIPv6(), Global: len(addrs) > 0, Addresses: addrs}
	if f.Global {
		d := net.Dialer{}
		f.Egress = IPv6EgressWorks(IPv6EgressTargets(os.Getenv(IPv6EgressTargetsEnv)), d.DialContext, ipv6EgressTimeout)
	}
	return f
}

// sharedIPv6 is the one cached probe the agent has: /healthz and every core's
// render read it, so they cannot disagree.
var sharedIPv6 = NewIPv6Prober(time.Minute)

// SharedIPv6Prober is what main wires into /healthz.
func SharedIPv6Prober() *IPv6Prober { return sharedIPv6 }

// The node's IPv6 setting (milestone 18.6), the operator's word over the
// check: "on" and "off" decide, anything else is "auto", the check's answer.
const (
	IPv6ModeAuto = "auto"
	IPv6ModeOn   = "on"
	IPv6ModeOff  = "off"
)

var (
	ipv6ModeMu sync.RWMutex
	ipv6Mode   = IPv6ModeAuto
)

// NormalizeIPv6Mode reads a wire value: only "on" and "off" mean something, an
// absent field or one this agent does not know is "auto".
func NormalizeIPv6Mode(m string) string {
	if m == IPv6ModeOn || m == IPv6ModeOff {
		return m
	}
	return IPv6ModeAuto
}

// SetIPv6Mode records the mode of the push the agent is applying, before any
// core renders it. It is in the stored request too, so a restart restores it
// ahead of the panel's first poll.
func SetIPv6Mode(m string) {
	ipv6ModeMu.Lock()
	ipv6Mode = NormalizeIPv6Mode(m)
	ipv6ModeMu.Unlock()
}

// IPv6ModeNow is the mode the cores render under.
func IPv6ModeNow() string {
	ipv6ModeMu.RLock()
	defer ipv6ModeMu.RUnlock()
	return ipv6Mode
}

// IPv6ByMode is the one rule: "on" is yes and "off" is no whatever the host
// says; "auto" asks `auto`, which is a global address AND an outbound
// connection that worked (EffectiveIPv6). An address on an interface with no
// route out (half-configured IPv6) is not enough.
func IPv6ByMode(mode string, auto func() bool) bool {
	switch mode {
	case IPv6ModeOn:
		return true
	case IPv6ModeOff:
		return false
	}
	return auto()
}

// EffectiveIPv6 is the one answer to "does this node leave by IPv6". Every
// core asks this, none the host directly. The facts stay what the check saw
// (/healthz reports them raw); the mode is applied here, and on/off do not run
// the check at all.
func EffectiveIPv6() bool {
	return IPv6ByMode(IPv6ModeNow(), func() bool {
		f := sharedIPv6.Facts()
		return f.Global && f.Egress
	})
}

// IPv6Render is what a core keeps of the answer its config was drawn under, so
// that a later push finding the answer changed (the mode flipped, or the check
// came out otherwise) draws again even when the inbound did not change. The
// holder guards it with its own lock.
type IPv6Render struct {
	known, v6 bool
}

// Note records the answer a render used.
func (r *IPv6Render) Note(v6 bool) { r.known, r.v6 = true, v6 }

// Stale: a config was drawn, and under the other answer than `now`.
func (r *IPv6Render) Stale(now bool) bool { return r.known && r.v6 != now }

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
