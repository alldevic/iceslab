package porthop

import (
	"context"
	"fmt"
	"testing"
)

// Verbatim `iptables -t nat -S PREROUTING` output from a lab node installed
// with the default range, read off the machine rather than composed here: the
// exact spelling (`-m udp` between `-p udp` and `--dport`, the colon in the
// range, the trailing `--to-ports`) is the whole thing this parses.
const realTable = `-P PREROUTING ACCEPT
-A PREROUTING -p udp -m udp --dport 20000:50000 -j REDIRECT --to-ports 443
-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER
`

func run(out string, err error) RunCmdFunc {
	return func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(out), err
	}
}

func TestReadsTheRangeARealNodeRedirects(t *testing.T) {
	got := Read(context.Background(), run(realTable, nil), 443)
	if got != (Range{Start: 20000, End: 50000}) {
		t.Fatalf("Read() = %+v, want 20000-50000", got)
	}
	if !got.Known() {
		t.Fatalf("a parsed range reports itself unknown: %+v", got)
	}
}

// Every one of these is a node that redirects NOTHING for hysteria, and the
// panel must hear the same "no answer" from all of them: a range invented from
// a half-match would gate an operator's save on a rule that is not there.
func TestUnknownIsUnknown(t *testing.T) {
	cases := []struct {
		name string
		out  string
		err  error
	}{
		{"iptables missing or not permitted", "", fmt.Errorf("exec: iptables: not found")},
		{"a table with no redirect at all", "-P PREROUTING ACCEPT\n", nil},
		{"empty output", "", nil},
		{
			// A single port, not a range: hopping needs a range, and reading
			// this as one would report 443-443 as a hopping window.
			"a single-port redirect",
			"-A PREROUTING -p udp -m udp --dport 443 -j REDIRECT --to-ports 443\n",
			nil,
		},
		{
			// TCP. A tcp range-redirect on the box is somebody else's rule.
			"a tcp range redirect",
			"-A PREROUTING -p tcp -m tcp --dport 20000:50000 -j REDIRECT --to-ports 443\n",
			nil,
		},
		{
			// DNAT, not REDIRECT: it sends traffic elsewhere entirely.
			"a udp range DNAT to another host",
			"-A PREROUTING -p udp -m udp --dport 20000:50000 -j DNAT --to-destination 10.0.0.5:443\n",
			nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Read(context.Background(), run(tc.out, tc.err), 443)
			if got.Known() {
				t.Fatalf("Read() = %+v, want the zero Range", got)
			}
		})
	}
}

// The reason the listen port is checked at all: another service on the box can
// hold a UDP range redirect, and reporting it would hand the panel a promise
// about hysteria that hysteria never made.
func TestOnlyARedirectAtTheHysteriaListenerCounts(t *testing.T) {
	table := "-A PREROUTING -p udp -m udp --dport 30000:40000 -j REDIRECT --to-ports 5353\n"

	if got := Read(context.Background(), run(table, nil), 443); got.Known() {
		t.Fatalf("claimed a redirect aimed at :5353 as hysteria's: %+v", got)
	}
	// The reverse, without which the case above is indistinguishable from "the
	// parser cannot read this line at all".
	if got := Read(context.Background(), run(table, nil), 5353); got != (Range{Start: 30000, End: 40000}) {
		t.Fatalf("Read() with the matching listener = %+v, want 30000-40000", got)
	}
}

// A node whose listener is not known (0) takes the first hysteria-shaped rule.
// That is the pre-existing behaviour for an agent with no configured port, and
// it beats reporting nothing at all.
func TestNoListenerGivenTakesTheFirstRangeRedirect(t *testing.T) {
	if got := Read(context.Background(), run(realTable, nil), 0); got != (Range{Start: 20000, End: 50000}) {
		t.Fatalf("Read() = %+v, want 20000-50000", got)
	}
}

func TestKnown(t *testing.T) {
	cases := []struct {
		r    Range
		want bool
	}{
		{Range{}, false},
		{Range{Start: 20000, End: 50000}, true},
		{Range{Start: 20000, End: 20000}, true}, // degenerate but real
		{Range{Start: 0, End: 50000}, false},
		{Range{Start: 50000, End: 20000}, false}, // inverted is not an answer
	}
	for _, tc := range cases {
		if got := tc.r.Known(); got != tc.want {
			t.Fatalf("%+v.Known() = %v, want %v", tc.r, got, tc.want)
		}
	}
}
