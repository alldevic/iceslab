package hopguard

import (
	"context"
	"regexp"
	"strconv"
	"time"
)

// ListenPort is where bootstrap-hysteria.sh points the port-hopping redirect
// (its LISTEN_PORT). ⚠ One value in two places: they change as a pair.
const ListenPort = 443

// Range is the UDP port range this node redirects to its Hysteria listener,
// inclusive. The zero Range is a node that redirects none.
type Range struct {
	Start int
	End   int
}

// A PREROUTING REDIRECT of a udp port RANGE, as `iptables -t nat -S` prints
// it:
//
//	-A PREROUTING -p udp -m udp --dport 20000:50000 -j REDIRECT --to-ports 443
//
// Matched as a whole, so a tcp range, a single port or a DNAT is not read as
// a hopping range.
var redirectRule = regexp.MustCompile(`-p udp .*--dport (\d+):(\d+) .*-j REDIRECT .*--to-ports (\d+)`)

// HopRange reads the port-hopping range from the nat table, not from the
// unit that writes it: the unit is what should be applied, the table is what
// is, and they differ exactly when it matters (a flushed table, a failed unit,
// a hand-edited rule).
//
// ok is false when the table could not be read, which the panel takes as "not
// reported", the same as an agent older than this. A host without iptables
// has no redirect: ok, and the zero Range. Only a redirect at ListenPort
// counts, so another service's UDP range redirect is not reported as this
// node's.
func (g *Guard) HopRange(ctx context.Context) (r Range, ok bool) {
	bin, err := g.LookPath("iptables")
	if err != nil {
		return Range{}, true
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := g.Run(ctx, "", bin, "-t", "nat", "-S", "PREROUTING")
	if err != nil {
		return Range{}, false
	}
	for _, m := range redirectRule.FindAllStringSubmatch(string(out), -1) {
		start, err1 := strconv.Atoi(m[1])
		end, err2 := strconv.Atoi(m[2])
		to, err3 := strconv.Atoi(m[3])
		if err1 != nil || err2 != nil || err3 != nil || to != ListenPort {
			continue
		}
		if start > 0 && end > start {
			return Range{Start: start, End: end}, true
		}
	}
	return Range{}, true
}
