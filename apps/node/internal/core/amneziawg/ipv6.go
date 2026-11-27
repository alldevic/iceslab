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

// invalidate drops the cached answer: the next ask runs the check again. Nil
// receiver (an adapter built without probes) is a no-op.
func (p *ipv6Probe) invalidate() {
	if p == nil {
		return
	}
	p.mu.Lock()
	p.checked = false
	p.mu.Unlock()
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

var _ interface{ AwgNoNat6() bool } = (*Adapter)(nil)

// AwgNoNat6 is the `awgNoNat6` fact (milestone 18.11): this agent knows the
// `noNat6` flag of a push, so a prefix routed to the node can be served with
// no NAT66. An agent of 18.10 reports awgIpv6 and not this one, and would put
// MASQUERADE on a real prefix: the panel then keeps that node on NAT66. The
// host's NAT table is still asked for (the fact is awgIpv6's, plus the flag):
// the rules of a real prefix need only the filter table, but one probe, one
// answer, and a node that can do neither is no node for IPv6 in the tunnel.
func (a *Adapter) AwgNoNat6() bool {
	return a.AwgIpv6()
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

// probeChain is the scratch chain the TPROXY probe adds a rule to; nothing
// else uses it, and it is removed again in the same breath.
const probeChain = "ICESLAB-TP6-PROBE"

// hostCanTProxy6 asks (or recalls) whether this host can steer IPv6 with TPROXY
// (milestone 18.12): `xt_TPROXY` with its IPv6 half in the kernel, the mangle
// table of ip6tables, and policy routing for IPv6 (`ip -6 rule`). TPROXY cannot
// be asked without trying, so a rule is added to a chain of its own, which no
// packet reaches, and dropped at once; a kernel that refuses it refuses it
// there, and not in a PostUp line, where one failure would take the whole `up`
// down with every IPv4 client. Cached like the NAT probe.
func (a *Adapter) hostCanTProxy6() bool {
	bin := a.cfg.Ip6tablesBin
	if bin == "" {
		bin = "ip6tables"
	}
	return a.cfg.tp6.hostNAT6(time.Now(), func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		run := func(name string, args ...string) error {
			_, err := a.cfg.runCmd(ctx, name, args...)
			return err
		}
		if err := run("ip", "-6", "rule", "show"); err != nil {
			a.logger.Warn(a.Name()+": no IPv6 policy routing on this host, IPv6 through a chain stays off", "err", err)
			return false
		}
		// A leftover of an interrupted probe would fail the -N below for good.
		_ = run(bin, "-t", "mangle", "-F", probeChain)
		_ = run(bin, "-t", "mangle", "-X", probeChain)
		if err := run(bin, "-t", "mangle", "-N", probeChain); err != nil {
			a.logger.Warn(a.Name()+": no IPv6 mangle table on this host, IPv6 through a chain stays off", "err", err)
			return false
		}
		err := run(bin, "-t", "mangle", "-A", probeChain, "-p", "tcp", "-j", "TPROXY",
			"--on-ip", "::1", "--on-port", "1", "--tproxy-mark", "0x1")
		_ = run(bin, "-t", "mangle", "-F", probeChain)
		_ = run(bin, "-t", "mangle", "-X", probeChain)
		if err != nil {
			a.logger.Warn(a.Name()+": no TPROXY for IPv6 on this host, IPv6 through a chain stays off", "err", err)
		}
		return err == nil
	})
}

// tproxy6Allowed: a hand-off may carry IPv6 only where the host can do it AND
// the agent brings up IPv6 in the tunnel at all. A push that asks anyway (a
// stale fact) is served without it, and the interface then has no IPv6 address
// (withDefaults), so nothing of the client's IPv6 leaves around the chain.
func (a *Adapter) tproxy6Allowed() bool {
	if a.plain() || !a.hostCanNAT6() {
		return false
	}
	return a.hostCanTProxy6()
}

var _ interface{ AwgTproxy6() bool } = (*Adapter)(nil)

// AwgTproxy6 is the `awgTproxy6` fact (milestone 18.12): a client's IPv6 on a
// cascade entry can be steered into the chain, so the panel may lift the ban of
// 18.9 for the node. Only the AmneziaWG module reports it.
func (a *Adapter) AwgTproxy6() bool {
	if a.plain() {
		return false
	}
	return a.tproxy6Allowed()
}
