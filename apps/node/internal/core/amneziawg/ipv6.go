package amneziawg

import (
	"context"
	"sync"
	"time"
)

/*
IPv6 inside the tunnel (milestone 18.10) needs the host to NAT it: the peers
have a private prefix, and what leaves the node must carry the node's address.
That is `ip6tables` with a `nat` table, which a kernel without ip6table_nat
does not have, and which a PostUp line cannot be allowed to discover by failing:
awg-quick runs the lines in order and a failed one takes the whole `up` down,
IPv4 clients with it.

So the agent asks once, with a call that changes nothing (`ip6tables -t nat -S`
only lists the table), and answers two things from it: the `awgIpv6` fact of
/healthz, which makes the panel send `subnet6`, and a refusal here to render
IPv6 for a push that carries it anyway (a stale fact, a panel ahead of the
node): the interface then comes up on IPv4 alone, as it did.
*/

// ipv6ProbeTTL: how long an answer stands. The installer can add the kernel
// module or the package under a running agent, and the node must not stay
// "no IPv6" until the next restart (the same reason the tools version is
// re-asked); a minute is slow enough that the health poll does not fork.
const ipv6ProbeTTL = time.Minute

// ipv6Probe is the cached answer, shared by the 1.x, 3.1 and plain instances:
// one host, one table.
type ipv6Probe struct {
	mu      sync.Mutex
	at      time.Time
	ok      bool
	checked bool
}

// hostNAT6 reports whether `<bin> -t nat -S` runs here. check is the call
// itself, injectable so the logic is testable without a kernel that has or
// lacks the module.
func (p *ipv6Probe) hostNAT6(now time.Time, check func() bool) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.checked && now.Sub(p.at) < ipv6ProbeTTL {
		return p.ok
	}
	p.ok = check()
	p.at = now
	p.checked = true
	return p.ok
}

// hostCanNAT6 asks (or recalls) whether this host can NAT IPv6.
func (a *Adapter) hostCanNAT6() bool {
	bin := a.cfg.Ip6tablesBin
	if bin == "" {
		bin = "ip6tables"
	}
	return a.cfg.ip6.hostNAT6(time.Now(), func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := a.cfg.runCmd(ctx, bin, "-t", "nat", "-S")
		if err != nil {
			a.logger.Warn(a.Name()+": no IPv6 NAT on this host, IPv6 in the tunnel stays off",
				"cmd", bin+" -t nat -S", "err", err)
		}
		return err == nil
	})
}

var _ interface{ AwgIpv6() bool } = (*Adapter)(nil)

// AwgIpv6 is the `awgIpv6` fact: this agent brings up IPv6 in the tunnel and
// the host can NAT it. Only the AmneziaWG module of the pair reports it; the
// panel reads that one fact for the whole family.
func (a *Adapter) AwgIpv6() bool {
	if a.plain() {
		return false
	}
	return a.hostCanNAT6()
}
