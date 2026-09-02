package amneziawg

import (
	"strconv"
	"strings"
	"testing"
)

// Bridge B (2026-09-02). A wg client's packet is decrypted and routed inside
// the kernel, so nothing in userspace can be told to hand it over: the divert
// has to be made by the node's network stack. These tests pin the rules that do
// it, because on a live node they are the half nobody can see from the panel -
// `ok` comes back either way, and the difference between a working bridge and a
// dead channel is one flag in one line.
//
// Every case here is written against what the s1 stand actually did on
// 2026-09-02, not against the shape of the code.

func bridgedDefaults(plain bool) InboundConfig {
	c := bridgedConfig(plain)
	return c.withDefaults()
}

func bridgedConfig(plain bool) InboundConfig {
	c := InboundConfig{
		Interface:        "wgb0",
		ListenPort:       51821,
		PrivateKey:       "aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkMTI=",
		Address:          "10.77.0.1/24",
		BridgeTproxyPort: 24101,
		Plain:            plain,
	}
	if !plain {
		c.H1, c.H2, c.H3, c.H4 = 1000000, 2000000, 3000000, 4000000
	}
	return c
}

func TestBridgeB_absentPortKeepsThePreBridgeShape(t *testing.T) {
	c := bridgedConfig(true)
	c.BridgeTproxyPort = 0
	got := c.withDefaults()

	// The whole promise of the zero value: a node the panel has nowhere to
	// bridge to renders exactly as it did before bridge B existed.
	joined := strings.Join(got.PostUp, "\n")
	if !strings.Contains(joined, "MASQUERADE") {
		t.Fatalf("no bridge must keep the plain NAT egress, got:\n%s", joined)
	}
	if strings.Contains(joined, "TPROXY") {
		t.Fatalf("no bridge must not divert anything, got:\n%s", joined)
	}
}

func TestBridgeB_divertsAndDropsTheBlanketNAT(t *testing.T) {
	got := bridgedDefaults(false)
	joined := strings.Join(got.PostUp, "\n")

	if !strings.Contains(joined, "-j TPROXY") {
		t.Fatalf("bridged interface must divert, got:\n%s", joined)
	}
	// A blanket MASQUERADE and a divert cannot coexist: whatever the divert
	// does not take would leave the node directly, which on a cascade entry is
	// egress from the wrong country - the exact defect the bridge closes,
	// reappearing for whichever flows missed a rule.
	for _, line := range got.PostUp {
		if strings.Contains(line, "MASQUERADE") && !strings.Contains(line, "-p icmp") {
			t.Fatalf("bridged interface must not NAT anything but icmp, got: %s", line)
		}
	}
	// ICMP is the one thing xray cannot carry. Left on the direct path on
	// purpose: silently dead ping reads to a buyer as "the VPN is broken".
	if !strings.Contains(joined, "-s 10.77.0.0/24 -p icmp") {
		t.Fatalf("icmp must keep a NAT of its own, scoped to the client subnet, got:\n%s", joined)
	}
}

func TestBridgeB_tproxyNamesTheLoopbackSocketExplicitly(t *testing.T) {
	got := bridgedDefaults(false)

	var tproxy []string
	for _, l := range got.PostUp {
		if strings.Contains(l, "-j TPROXY") {
			tproxy = append(tproxy, l)
		}
	}
	// TCP and UDP, both. REDIRECT would have covered only TCP and rewritten the
	// destination; a wg client carries DNS and QUIC, and losing them is silent.
	if len(tproxy) != 2 {
		t.Fatalf("want a tcp and a udp divert, got %d: %v", len(tproxy), tproxy)
	}
	var haveTCP, haveUDP bool
	for _, l := range tproxy {
		// Without --on-ip, xt_TPROXY looks the socket up on the INPUT
		// INTERFACE's address - the tunnel address, where nothing listens - and
		// every packet dies with no log on either side.
		if !strings.Contains(l, "--on-ip 127.0.0.1") {
			t.Fatalf("divert must name the loopback socket explicitly: %s", l)
		}
		if !strings.Contains(l, "--on-port 24101") {
			t.Fatalf("divert must carry the port the panel emitted: %s", l)
		}
		if strings.Contains(l, "-p tcp") {
			haveTCP = true
		}
		if strings.Contains(l, "-p udp") {
			haveUDP = true
		}
	}
	if !haveTCP || !haveUDP {
		t.Fatalf("tcp=%v udp=%v, both are required: %v", haveTCP, haveUDP, tproxy)
	}
}

func TestBridgeB_exclusionsComeBeforeTheDivert(t *testing.T) {
	got := bridgedDefaults(false)

	firstTproxy := -1
	for i, l := range got.PostUp {
		if strings.Contains(l, "-j TPROXY") {
			firstTproxy = i
			break
		}
	}
	if firstTproxy < 0 {
		t.Fatal("no divert rendered at all")
	}
	// -A appends, so anything that must win has to be written first. Getting
	// this backwards is not a broken tunnel: it is a working one that will
	// fetch the hoster's cloud metadata, or reach its internal LAN, on behalf
	// of whoever asks.
	for _, dest := range []string{"169.254.0.0/16", "192.168.0.0/16", "10.0.0.0/8", "127.0.0.0/8"} {
		idx := -1
		for i, l := range got.PostUp {
			if strings.Contains(l, "-d "+dest+" -j RETURN") {
				idx = i
				break
			}
		}
		if idx < 0 {
			t.Fatalf("%s must be excluded from the bridge", dest)
		}
		if idx > firstTproxy {
			t.Fatalf("%s is excluded at %d, after the divert at %d", dest, idx, firstTproxy)
		}
	}
}

func TestBridgeB_marksDifferPerFlavour(t *testing.T) {
	// A node can run wireguard and amneziawg at once, and the `ip rule` and
	// routing table the divert needs are node-global. One shared pair would
	// have two owners, and whichever interface went down second would delete a
	// rule the other still needed.
	if bridgeMark(true) == bridgeMark(false) {
		t.Fatal("the two flavours must not share a mark")
	}
	if bridgeTable(true) == bridgeTable(false) {
		t.Fatal("the two flavours must not share a routing table")
	}
	plain := strings.Join(bridgedDefaults(true).PostUp, "\n")
	awg := strings.Join(bridgedDefaults(false).PostUp, "\n")
	if !strings.Contains(plain, "--tproxy-mark "+bridgeMark(true)) {
		t.Fatalf("plain wireguard must mark with %s:\n%s", bridgeMark(true), plain)
	}
	if !strings.Contains(awg, "--tproxy-mark "+bridgeMark(false)) {
		t.Fatalf("amneziawg must mark with %s:\n%s", bridgeMark(false), awg)
	}
}

func TestBridgeB_postDownUndoesEveryPostUp(t *testing.T) {
	got := bridgedDefaults(false)

	// Rules that outlive their interface divert nothing while looking
	// installed. Every rule added must have its exact removal, or a disabled
	// binding leaves the node quietly mangling traffic for an interface that no
	// longer exists.
	var added []string
	for _, l := range got.PostUp {
		if strings.HasPrefix(l, "iptables ") {
			added = append(added, l)
		}
	}
	if len(added) != len(got.PostDown) {
		t.Fatalf("%d rules added, %d removed:\nup:\n%s\ndown:\n%s",
			len(added), len(got.PostDown), strings.Join(added, "\n"), strings.Join(got.PostDown, "\n"))
	}
	// Independent of how either side derives the removal: `-D` never takes an
	// insert position. `iptables -D FORWARD 1 -o %i ...` is read as a rule
	// number AND a spec at once, and refused - which is a divert left running
	// for an interface that is gone.
	for _, d := range got.PostDown {
		f := strings.Fields(d)
		for i, tok := range f {
			if tok == "-D" && i+2 < len(f) {
				if _, err := strconv.Atoi(f[i+2]); err == nil {
					t.Fatalf("-D carries an insert position: %s", d)
				}
			}
		}
	}

	for i, up := range added {
		if got.PostDown[i] != undoOf(up) {
			t.Fatalf("rule %d\n  up:   %s\n  want: %s\n  got:  %s", i, up, undoOf(up), got.PostDown[i])
		}
	}
}

// undoOf derives the removal of an iptables rule from the rule itself, by the
// shape of the command rather than by string surgery on it: -A CHAIN and
// -I CHAIN POS both become -D CHAIN, and everything after the chain (bar the
// insert position) is the match spec and must be carried over verbatim. An
// approximate -D silently removes nothing.
func undoOf(add string) string {
	f := strings.Fields(add)
	out := make([]string, 0, len(f))
	for i := 0; i < len(f); i++ {
		switch f[i] {
		case "-A":
			out = append(out, "-D", f[i+1])
			i++
		case "-I":
			out = append(out, "-D", f[i+1])
			i += 2 // chain, then the insert position, which -D does not take
		default:
			out = append(out, f[i])
		}
	}
	return strings.Join(out, " ")
}

func TestBridgeB_everyHookSurvivesTheWhitelist(t *testing.T) {
	// awg-quick runs these as root. renderConfig refuses a hook outside the
	// whitelist, so a rule that trips it does not produce a warning - it
	// produces an interface that never comes up.
	for _, plain := range []bool{true, false} {
		c := bridgedDefaults(plain)
		for _, l := range append(append([]string{}, c.PostUp...), c.PostDown...) {
			if err := validatePostHook(l); err != nil {
				t.Fatalf("plain=%v hook rejected by the whitelist: %q: %v", plain, l, err)
			}
		}
	}
}

func TestBridgeB_rendersIntoTheInterfaceBlock(t *testing.T) {
	for _, plain := range []bool{true, false} {
		blob, err := renderConfig(bridgedConfig(plain), nil)
		if err != nil {
			t.Fatalf("plain=%v: render: %v", plain, err)
		}
		if !strings.Contains(blob, "PostUp = iptables -t mangle -A PREROUTING -i %i -p tcp -j TPROXY") {
			t.Fatalf("plain=%v: divert missing from the rendered config:\n%s", plain, blob)
		}
		if !strings.Contains(blob, "PostDown = iptables -t mangle -D PREROUTING -i %i -p tcp -j TPROXY") {
			t.Fatalf("plain=%v: teardown missing from the rendered config:\n%s", plain, blob)
		}
	}
}

func TestBridgeB_portChangeBouncesTheInterface(t *testing.T) {
	// PostUp/PostDown run only at bring-up. `syncconf` would report success and
	// change nothing at all, which is how a moved port becomes a dead channel
	// that every side calls healthy.
	old := bridgedConfig(false)
	next := old
	next.BridgeTproxyPort = 24102
	if kind := classifyDiff(old, next); kind != diffRestart {
		t.Fatalf("want diffRestart for a changed bridge port, got %v", kind)
	}
	off := old
	off.BridgeTproxyPort = 0
	if kind := classifyDiff(old, off); kind != diffRestart {
		t.Fatalf("want diffRestart for a bridge being turned off, got %v", kind)
	}
	if kind := classifyDiff(old, old); kind != diffNone {
		t.Fatalf("want diffNone for an unchanged config, got %v", kind)
	}
}

func TestBridgeB_subnetFromAddress(t *testing.T) {
	// The one NAT rule the bridge keeps names a source RANGE. A MASQUERADE that
	// named neither an interface nor a range would cover the whole box.
	for _, tc := range []struct{ in, want string }{
		{"10.77.0.1/24", "10.77.0.0/24"},
		{"172.20.5.1/16", "172.20.0.0/16"},
	} {
		got, err := subnetFromAddress(tc.in)
		if err != nil {
			t.Fatalf("%s: %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("%s -> %s, want %s", tc.in, got, tc.want)
		}
	}
	if _, err := subnetFromAddress("not-an-address"); err == nil {
		t.Fatal("a malformed address must be an error, not a silently wrong subnet")
	}
}
