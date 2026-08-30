// Package porthop reports the Hysteria 2 port-hopping range THIS node actually
// redirects.
//
// The range is decided at install time (`--hysteria-port-range`, default
// 20000-50000) and lives in an iptables nat REDIRECT rule. The panel had no way
// to know it, so it accepted any range on a profile - including one this node
// does not catch, which is a client honestly rotating its destination port
// across ports nobody is listening on. Nothing anywhere reports that: the
// tunnel simply does not come up, on some connections and not others.
//
// A rule on the panel side guessing the number would be worse than none: it
// would refuse a node deliberately installed with a different range. So the
// node says what it does, the way §55 made it say which ENGINE runs a core.
//
// Asked of the nat table rather than of the unit file that writes it. The unit
// is what SHOULD be applied; the table is what IS. They differ exactly when it
// matters - a flushed table, a failed unit, a hand-edited rule - and the panel
// is about to gate an operator's save on the answer.
package porthop

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"time"
)

// Range is an inclusive UDP port range this node redirects to its Hysteria
// listener. The zero value means "not reported": no rule, no iptables, or a
// query that failed - three states the panel treats alike, because none of them
// is a promise it can gate on.
type Range struct {
	Start int
	End   int
}

// Known reports whether this Range carries an actual answer.
func (r Range) Known() bool { return r.Start > 0 && r.End >= r.Start }

// RunCmdFunc runs a command and returns its combined output. Tests inject a
// fake; the default shells out.
type RunCmdFunc func(ctx context.Context, name string, args ...string) ([]byte, error)

func defaultRunCmd(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// A PREROUTING REDIRECT for a UDP port RANGE. `iptables -t nat -S` prints
// rules in the form
//
//	-A PREROUTING -p udp -m udp --dport 20000:50000 -j REDIRECT --to-ports 443
//
// Matched as a whole line rather than by scanning for `--dport`, so a rule that
// redirects a range for something OTHER than udp, or a single port rather than
// a range, is not read as a hopping range.
var redirectRule = regexp.MustCompile(
	`-p udp .*--dport (\d+):(\d+).*-j REDIRECT.*--to-ports (\d+)`,
)

// Read returns the port-hopping range in this node's nat table.
//
// `listenPort` is the port the Hysteria inbound is served on; only a redirect
// pointing AT it counts. Without that, an unrelated UDP range-redirect on the
// box (another service, another tenant) would be reported as this node's
// hopping range, and the panel would gate profile saves on somebody else's rule.
//
// Every failure answers the zero Range. There is no error to return that the
// caller could act on: a node with no iptables, no rule, or no permission is a
// node that reports nothing, and the panel already treats "nothing" as "do not
// gate".
func Read(ctx context.Context, run RunCmdFunc, listenPort int) Range {
	if run == nil {
		run = defaultRunCmd
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	out, err := run(ctx, "iptables", "-t", "nat", "-S", "PREROUTING")
	if err != nil {
		return Range{}
	}
	for _, m := range redirectRule.FindAllStringSubmatch(string(out), -1) {
		start, err1 := strconv.Atoi(m[1])
		end, err2 := strconv.Atoi(m[2])
		to, err3 := strconv.Atoi(m[3])
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		if listenPort > 0 && to != listenPort {
			continue
		}
		r := Range{Start: start, End: end}
		if r.Known() {
			return r
		}
	}
	return Range{}
}
