package hopguard

import (
	"context"
	"errors"
	"log/slog"
	"testing"
)

// A guard whose iptables prints `table` for `-t nat -S PREROUTING`, or fails.
func reading(table string, runErr error, missing bool) *Guard {
	return &Guard{
		Logger: slog.New(slog.DiscardHandler),
		Run: func(_ context.Context, _, _ string, _ ...string) ([]byte, error) {
			return []byte(table), runErr
		},
		LookPath: func(bin string) (string, error) {
			if missing {
				return "", errors.New("not found")
			}
			return bin, nil
		},
	}
}

// Verbatim `iptables -t nat -S PREROUTING` from a node installed with the
// default range, with the guard's own jump and docker's rule around it: the
// exact spelling (`-m udp` between `-p udp` and `--dport`, the colon) is what
// this parses.
const realTable = `-P PREROUTING ACCEPT
-A PREROUTING -p udp -j ICESLAB-HOPKEEP
-A PREROUTING -p udp -m udp --dport 20000:50000 -j REDIRECT --to-ports 443
-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER
`

func TestHopRangeReadsWhatTheNodeRedirects(t *testing.T) {
	r, ok := reading(realTable, nil, false).HopRange(context.Background())
	if !ok || r != (Range{Start: 20000, End: 50000}) {
		t.Fatalf("HopRange() = %+v, %v; want 20000-50000, true", r, ok)
	}
	r, ok = reading(`-A PREROUTING -p udp -m udp --dport 30000:40000 -j REDIRECT --to-ports 443`, nil, false).HopRange(context.Background())
	if !ok || r != (Range{Start: 30000, End: 40000}) {
		t.Fatalf("an operator's own range: %+v, %v", r, ok)
	}
}

// Each of these is a node that redirects nothing to hysteria: a reported
// "none", not a range made up from half a match.
func TestHopRangeNone(t *testing.T) {
	for name, table := range map[string]string{
		"no redirect at all":     "-P PREROUTING ACCEPT\n",
		"empty output":           "",
		"a single port":          "-A PREROUTING -p udp -m udp --dport 443 -j REDIRECT --to-ports 443\n",
		"a tcp range":            "-A PREROUTING -p tcp -m tcp --dport 20000:50000 -j REDIRECT --to-ports 443\n",
		"a DNAT, not a redirect": "-A PREROUTING -p udp -m udp --dport 20000:50000 -j DNAT --to-destination 10.0.0.2:443\n",
		"somebody else's range":  "-A PREROUTING -p udp -m udp --dport 20000:50000 -j REDIRECT --to-ports 5353\n",
	} {
		r, ok := reading(table, nil, false).HopRange(context.Background())
		if !ok || r != (Range{}) {
			t.Errorf("%s: HopRange() = %+v, %v; want none, true", name, r, ok)
		}
	}
	if r, ok := reading("", nil, true).HopRange(context.Background()); !ok || r != (Range{}) {
		t.Errorf("no iptables: HopRange() = %+v, %v; want none, true", r, ok)
	}
}

// A table that could not be read is not a node without hopping: the panel
// must hear "not reported" and keep its own default.
func TestHopRangeUnreadableIsNotReported(t *testing.T) {
	if _, ok := reading("", errors.New("permission denied"), false).HopRange(context.Background()); ok {
		t.Fatal("a failed iptables read was reported as an answer")
	}
}
