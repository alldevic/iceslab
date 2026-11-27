package amneziawg

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// Milestone 18.10: IPv6 inside the WireGuard-family tunnel, on the agent. The
// host's NAT66 is faked (ip6tables answers or fails), no kernel is needed.

const (
	test6Subnet = "fd5a:1c3e:9b2d:1::/64"
	test6Server = "fd5a:1c3e:9b2d:1::1/64"
	test6Peer   = "fd5a:1c3e:9b2d:1::2/128"
)

// ip6Host answers like a host: `ip6tables -t nat -S` succeeds unless nat6 is
// false, everything else succeeds.
func ip6Host(nat6 bool) *fakeCLI {
	return &fakeCLI{handler: func(name string, args []string) ([]byte, error) {
		if name == "ip6tables" && !nat6 {
			return []byte("ip6tables v1.8.9: can't initialize ip6tables table `nat': Table does not exist"), errors.New("exit status 3")
		}
		return nil, nil
	}}
}

func (f *fakeCLI) count(prefix string) int {
	n := 0
	for _, s := range f.sequence() {
		if strings.HasPrefix(s, prefix) {
			n++
		}
	}
	return n
}

func wire6(t *testing.T, mut func(m map[string]any)) json.RawMessage {
	t.Helper()
	return wirePayload(t, func(m map[string]any) {
		m["subnet6"] = test6Subnet
		if mut != nil {
			mut(m)
		}
	})
}

func managed6Adapter(t *testing.T, fake *fakeCLI) (*Adapter, string) {
	t.Helper()
	cfgPath := filepath.Join(t.TempDir(), "awg0.conf")
	return installedAdapter(t, cfgPath, fake), cfgPath
}

func TestServerAddress6FromSubnet(t *testing.T) {
	for _, c := range []struct {
		in, out string
		err     bool
	}{
		{test6Subnet, test6Server, false},
		{"fd00::/64", "fd00::1/64", false},
		{"fd00:1:2:3::/48", "fd00:1:2::1/48", false}, // masked first
		{"fd00:1::5/64", "fd00:1::1/64", false},      // host bits are the prefix's, not the caller's
		{"10.0.0.0/24", "", true},
		{"::ffff:10.0.0.0/120", "", true},
		{"fd00::/127", "", true},
		{"garbage", "", true},
	} {
		got, err := serverAddress6FromSubnet(c.in)
		if c.err != (err != nil) || got != c.out {
			t.Errorf("serverAddress6FromSubnet(%q) = %q, %v; want %q (err %v)", c.in, got, err, c.out, c.err)
		}
	}
}

func TestEnsureCIDRKnowsBothFamilies(t *testing.T) {
	for in, want := range map[string]string{
		"10.0.0.2":    "10.0.0.2/32",
		"10.0.0.2/32": "10.0.0.2/32",
		"fd5a::2":     "fd5a::2/128",
		"fd5a::2/128": "fd5a::2/128",
		"":            "",
	} {
		if got := ensureCIDR(in); got != want {
			t.Errorf("ensureCIDR(%q) = %q, want %q", in, got, want)
		}
	}
}

// The IPv6 half of the address is a restart, the IPv4 one is still a subnet
// change; both at once is the subnet change, which peers veto.
func TestClassifyDiffSeparatesTheIpv6HalfFromASubnetChange(t *testing.T) {
	base := validInbound()
	with6 := base
	with6.Address6 = test6Server
	other6 := base
	other6.Address6 = "fd5a:1c3e:9b2d:2::1/64"
	moved := with6
	moved.Address = "172.16.0.1/24"
	for _, c := range []struct {
		name     string
		old, new InboundConfig
		want     diffKind
	}{
		{"appears", base, with6, diffRestart},
		{"goes", with6, base, diffRestart},
		{"changes", with6, other6, diffRestart},
		{"unchanged", with6, with6, diffNone},
		{"ipv4 subnet", with6, moved, diffSubnet},
		{"ipv4 subnet and ipv6 gone", with6, func() InboundConfig { m := moved; m.Address6 = ""; return m }(), diffSubnet},
	} {
		if got := classifyDiff(c.old, c.new); got != c.want {
			t.Errorf("%s: classifyDiff = %d, want %d", c.name, got, c.want)
		}
	}
}

func TestRenderCarriesTwoAddressesAndPeersWithBothFamilies(t *testing.T) {
	in := validInbound()
	in.Address6 = test6Server
	blob, err := renderConfig(in, []Peer{{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2/32", AllowedIP6: test6Peer}})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"Address = 10.66.66.1/24, " + test6Server + "\n",
		"AllowedIPs = 10.66.66.2/32, " + test6Peer + "\n",
	} {
		if !strings.Contains(blob, want) {
			t.Errorf("config misses %q:\n%s", want, blob)
		}
	}
}

// A peer's IPv6 outside an interface with no IPv6 address routes nowhere; and
// without any IPv6 the render is the one of before.
func TestRenderWithoutAddress6IsTheBaseRender(t *testing.T) {
	peers := []Peer{{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2/32", AllowedIP6: test6Peer}}
	blob, err := renderConfig(validInbound(), peers)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := renderConfig(validInbound(), []Peer{{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2/32"}})
	if err != nil {
		t.Fatal(err)
	}
	if blob != plain || strings.Contains(blob, "ip6tables") || strings.Contains(blob, "fd5a") {
		t.Errorf("IPv6 leaked into an interface without Address6:\n%s", blob)
	}
}

func TestRenderRefusesWhatIsNotAnIpv6Address(t *testing.T) {
	in := validInbound()
	in.Address6 = test6Server
	for _, bad := range []string{"10.66.66.9/32", "fd5a:1c3e:9b2d:1::/64", "fd5a::2/128\nPostUp = x", "fd5a::2"} {
		if _, err := renderConfig(in, []Peer{{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2/32", AllowedIP6: bad}}); err == nil {
			t.Errorf("AllowedIP6 %q rendered", bad)
		}
	}
	in.Address6 = "10.0.0.1/24"
	if _, err := renderConfig(in, nil); err == nil {
		t.Error("an IPv4 Address6 rendered")
	}
}

// The hooks: three more rules through ip6tables, and PostDown deletes exactly
// what PostUp added; every line is one validatePostHook lets through.
func TestIpv6HooksMirrorAndPassTheWhitelist(t *testing.T) {
	in := validInbound()
	base := in.withDefaults()
	in.Address6 = test6Server
	cfg := in.withDefaults()

	// The IPv4 part is the base's, untouched, and first.
	if len(cfg.PostUp) != len(base.PostUp)+3 || len(cfg.PostDown) != len(base.PostDown)+3 {
		t.Fatalf("hooks: up %v, down %v", cfg.PostUp, cfg.PostDown)
	}
	for i := range base.PostUp {
		if cfg.PostUp[i] != base.PostUp[i] || cfg.PostDown[i] != base.PostDown[i] {
			t.Errorf("IPv4 hook %d changed: %q / %q", i, cfg.PostUp[i], cfg.PostDown[i])
		}
	}
	up6, down6 := cfg.PostUp[len(base.PostUp):], cfg.PostDown[len(base.PostDown):]
	wantUp := []string{
		"ip6tables -I FORWARD 1 -i %i -j ACCEPT",
		"ip6tables -I FORWARD 1 -o %i -j ACCEPT",
		"ip6tables -t nat -A POSTROUTING -s fd5a:1c3e:9b2d:1::/64 ! -o %i -j MASQUERADE",
	}
	wantDown := []string{
		"ip6tables -D FORWARD -i %i -j ACCEPT",
		"ip6tables -D FORWARD -o %i -j ACCEPT",
		"ip6tables -t nat -D POSTROUTING -s fd5a:1c3e:9b2d:1::/64 ! -o %i -j MASQUERADE",
	}
	if strings.Join(up6, "|") != strings.Join(wantUp, "|") || strings.Join(down6, "|") != strings.Join(wantDown, "|") {
		t.Errorf("up %q\ndown %q", up6, down6)
	}
	// Mirror: -I FORWARD 1 / -A POSTROUTING turn into -D with the same match.
	for i := range up6 {
		mirrored := strings.NewReplacer("-I FORWARD 1", "-D FORWARD", "-A POSTROUTING", "-D POSTROUTING").Replace(up6[i])
		if mirrored != down6[i] {
			t.Errorf("PostDown[%d] %q is not the mirror of %q", i, down6[i], up6[i])
		}
	}
	for _, c := range append(append([]string{}, cfg.PostUp...), cfg.PostDown...) {
		if err := validatePostHook(c); err != nil {
			t.Errorf("%q: %v", c, err)
		}
	}
	if _, err := renderConfig(in, nil); err != nil {
		t.Fatalf("render with the IPv6 hooks: %v", err)
	}
}

func TestPeerNetwork6(t *testing.T) {
	for in, want := range map[string]string{test6Server: "fd5a:1c3e:9b2d:1::/64", "": "", "10.0.0.1/24": "", "junk": ""} {
		if got := peerNetwork6(in); got != want {
			t.Errorf("peerNetwork6(%q) = %q, want %q", in, got, want)
		}
	}
	// And the v4 helper still reads a comma list's first element, as before.
	if got := peerNetwork("10.0.0.1/24, " + test6Server); got != "10.0.0.0/24" {
		t.Errorf("peerNetwork over a two-address list = %q", got)
	}
}

// Enabling subnet6 on a profile that has live peers: the interface comes up
// again with the same peers, it is not refused.
func TestEnablingIpv6WithLivePeersRestartsTheInterfaceAndKeepsThem(t *testing.T) {
	fake := ip6Host(true)
	a, cfgPath := managed6Adapter(t, fake)
	if err := a.ApplyInbound(51820, wirePayload(t, nil)); err != nil {
		t.Fatal(err)
	}
	for _, u := range []core.User{
		{UserID: "u1", AmneziaWGPublicKey: testWGPubKeyA, AmneziaWGAllowedIP: "10.0.0.2"},
		{UserID: "u2", AmneziaWGPublicKey: testWGPubKeyB, AmneziaWGAllowedIP: "10.0.0.3"},
	} {
		if err := a.AddUser(u); err != nil {
			t.Fatal(err)
		}
	}
	downs, ups := fake.count("awg-quick down"), fake.count("awg-quick up")

	if err := a.ApplyInbound(51820, wire6(t, nil)); err != nil {
		t.Fatalf("the IPv6 part with live peers was refused: %v", err)
	}
	if fake.count("awg-quick down") != downs+1 || fake.count("awg-quick up") != ups+1 {
		t.Errorf("not one restart: %v", fake.sequence())
	}
	blob, _ := os.ReadFile(cfgPath)
	for _, want := range []string{"Address = 10.0.0.1/24, " + test6Server, testWGPubKeyA, testWGPubKeyB, "AllowedIPs = 10.0.0.2/32\n", "ip6tables -t nat -A POSTROUTING"} {
		if !strings.Contains(string(blob), want) {
			t.Errorf("config after the restart misses %q:\n%s", want, blob)
		}
	}
	// The panel then re-sends the users with their IPv6; the peer gets it.
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPublicKey: testWGPubKeyA, AmneziaWGAllowedIP: "10.0.0.2", AmneziaWGAllowedIP6: "fd5a:1c3e:9b2d:1::2"}); err != nil {
		t.Fatal(err)
	}
	blob, _ = os.ReadFile(cfgPath)
	if !strings.Contains(string(blob), "AllowedIPs = 10.0.0.2/32, "+test6Peer+"\n") {
		t.Errorf("the peer has no IPv6:\n%s", blob)
	}
	// Same push again: nothing to do.
	n := len(fake.sequence())
	if err := a.ApplyInbound(51820, wire6(t, nil)); err != nil {
		t.Fatal(err)
	}
	if len(fake.sequence()) != n {
		t.Errorf("an unchanged push ran commands: %v", fake.sequence()[n:])
	}
	// Taking it away is a restart too, and the peers stay.
	if err := a.ApplyInbound(51820, wirePayload(t, nil)); err != nil {
		t.Fatal(err)
	}
	blob, _ = os.ReadFile(cfgPath)
	if strings.Contains(string(blob), "fd5a") || strings.Contains(string(blob), "ip6tables") || !strings.Contains(string(blob), testWGPubKeyB) {
		t.Errorf("after IPv6 goes:\n%s", blob)
	}
}

func TestAnIpv4SubnetChangeWithPeersIsStillRefusedWhenIpv6RidesAlong(t *testing.T) {
	fake := ip6Host(true)
	a, _ := managed6Adapter(t, fake)
	if err := a.ApplyInbound(51820, wire6(t, nil)); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPublicKey: testWGPubKeyA, AmneziaWGAllowedIP: "10.0.0.2"}); err != nil {
		t.Fatal(err)
	}
	err := a.ApplyInbound(51820, wire6(t, func(m map[string]any) { m["subnet"] = "172.16.0.0/24" }))
	if err == nil || !strings.Contains(err.Error(), "subnet change rejected") {
		t.Errorf("err = %v", err)
	}
}

// No ip6table_nat: the push's subnet6 is not applied, the interface comes up
// on IPv4, and a PostUp that would fail the whole `up` is never written.
func TestAHostWithoutIpv6NatServesTheTunnelOnIpv4(t *testing.T) {
	fake := ip6Host(false)
	a, cfgPath := managed6Adapter(t, fake)
	if err := a.ApplyInbound(51820, wire6(t, nil)); err != nil {
		t.Fatalf("a push with subnet6 failed on a host without IPv6 NAT: %v", err)
	}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPublicKey: testWGPubKeyA, AmneziaWGAllowedIP: "10.0.0.2", AmneziaWGAllowedIP6: "fd5a:1c3e:9b2d:1::2"}); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(cfgPath)
	if strings.Contains(string(blob), "ip6tables") || strings.Contains(string(blob), "fd5a") {
		t.Errorf("IPv6 on a host that cannot NAT it:\n%s", blob)
	}
	if !strings.Contains(string(blob), "Address = 10.0.0.1/24\n") || !strings.Contains(string(blob), "AllowedIPs = 10.0.0.2/32\n") {
		t.Errorf("IPv4 is gone:\n%s", blob)
	}
	if a.AwgIpv6() {
		t.Error("the fact is true on a host without IPv6 NAT")
	}
}

// A push without subnet6 never asks the host anything.
func TestAPushWithoutSubnet6DoesNotProbe(t *testing.T) {
	fake := ip6Host(true)
	a, _ := managed6Adapter(t, fake)
	if err := a.ApplyInbound(51820, wirePayload(t, nil)); err != nil {
		t.Fatal(err)
	}
	if n := fake.count("ip6tables"); n != 0 {
		t.Errorf("ip6tables ran %d times for a push without IPv6", n)
	}
}

// The probe is `ip6tables -t nat -S`, which changes nothing, is asked once a
// minute at most, and is shared by every instance of the host.
func TestTheProbeListsTheNatTableAndIsCached(t *testing.T) {
	fake := ip6Host(true)
	a, _ := managed6Adapter(t, fake)
	for i := 0; i < 5; i++ {
		if !a.AwgIpv6() {
			t.Fatal("the fact is false on a host with IPv6 NAT")
		}
	}
	seq := fake.sequence()
	if len(seq) != 1 || seq[0] != "ip6tables -t nat -S" {
		t.Errorf("probe calls = %v", seq)
	}
}

func TestTheProbeAnswerExpires(t *testing.T) {
	var p ipv6Probe
	now := time.Unix(1000, 0)
	answer, calls := false, 0
	check := func() bool { calls++; return answer }
	if p.hostNAT6(now, check) || calls != 1 {
		t.Fatal("first ask")
	}
	answer = true // the installer adds the module under the running agent
	if p.hostNAT6(now.Add(ipv6ProbeTTL-time.Second), check) || calls != 1 {
		t.Error("asked again inside the TTL")
	}
	if !p.hostNAT6(now.Add(ipv6ProbeTTL), check) || calls != 2 {
		t.Error("the new answer is not picked up after the TTL")
	}
}

func TestPlainReportsNoAwgIpv6ButStillGatesItsOwnPush(t *testing.T) {
	fake := ip6Host(false)
	a := newPlainAdapter(t, t.TempDir(), fake)
	if a.AwgIpv6() {
		t.Error("a plain instance reports the AmneziaWG fact")
	}
	if fake.count("ip6tables") != 0 {
		t.Error("the plain instance's fact probed")
	}
	if err := a.ApplyInbound(51899, plainWire(t, map[string]any{"subnet6": test6Subnet})); err != nil {
		t.Fatal(err)
	}
	if a.cfg.Inbound.Address6 != "" {
		t.Error("plain brought IPv6 up on a host without NAT")
	}
}

// Plain WireGuard goes through the same renderer: two addresses, the peer's
// /128, the ip6tables rules.
func TestPlainWireguardCarriesIpv6Too(t *testing.T) {
	fake := ip6Host(true)
	dir := t.TempDir()
	a := newPlainAdapter(t, dir, fake)
	if err := a.ApplyInbound(51899, plainWire(t, map[string]any{"subnet6": test6Subnet})); err != nil {
		t.Fatal(err)
	}
	u := plainUser("u1", testWGPubKeyA, "10.77.77.2")
	u.WireguardAllowedIP6 = "fd5a:1c3e:9b2d:1::2"
	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	// Device list form too: the plain addresses, not the 1.x ones.
	d := core.User{UserID: "u2", AmneziaWGPeers: []core.AmneziaWGPeer{{
		PublicKey: testWGPubKeyB, AllowedIP: "10.0.0.9", AllowedIP6: "fd00::9",
		WireguardAllowedIP: "10.77.77.3", WireguardAllowedIP6: "fd5a:1c3e:9b2d:1::3",
	}}}
	if err := a.AddUser(d); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(filepath.Join(dir, "wg0.conf"))
	for _, want := range []string{
		"Address = 10.77.77.1/24, " + test6Server + "\n",
		"AllowedIPs = 10.77.77.2/32, " + test6Peer + "\n",
		"AllowedIPs = 10.77.77.3/32, fd5a:1c3e:9b2d:1::3/128\n",
		"PostUp = ip6tables -t nat -A POSTROUTING -s fd5a:1c3e:9b2d:1::/64 ! -o %i -j MASQUERADE",
		"PostDown = ip6tables -D FORWARD -i %i -j ACCEPT",
	} {
		if !strings.Contains(string(blob), want) {
			t.Errorf("wg0.conf misses %q:\n%s", want, blob)
		}
	}
	if strings.Contains(string(blob), "fd00::9") {
		t.Errorf("the 1.x address crossed onto the plain interface:\n%s", blob)
	}
}

// The 3.1 interface: its own subnet6, and the device's 3.1 IPv6, not the 1.x one.
func TestTheSecondGenerationCarriesItsOwnIpv6(t *testing.T) {
	fake := ip6Host(true)
	dir := t.TempDir()
	a := New(Config{
		Inbound:     InboundConfig{Interface: "awg0"},
		ConfigPath:  filepath.Join(dir, "awg0.conf"),
		AwgBin:      "awg",
		AwgQuickBin: "awg-quick",
		runCmd:      fake.run,
	}, quietLogger())
	one := inboundJSON(t, "b1", 1, nil)
	three := inboundJSON(t, "b3", 3, fixtureWire(t))
	with6 := func(raw json.RawMessage, s6 string) json.RawMessage {
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		m["subnet6"] = s6
		b, _ := json.Marshal(m)
		return b
	}
	if err := a.ApplyInbound(51820, with6(one, test6Subnet)); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(51830, with6(three, "fd5a:1c3e:9b2d:2::/64")); err != nil {
		t.Fatal(err)
	}
	u := core.User{UserID: "u1", AmneziaWGPeers: []core.AmneziaWGPeer{{
		PublicKey: testWGPubKeyA,
		AllowedIP: "10.66.66.2", AllowedIP6: "fd5a:1c3e:9b2d:1::2",
		AllowedIP3: "10.67.67.2", AllowedIP3v6: "fd5a:1c3e:9b2d:2::2",
	}}}
	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	b1, _ := os.ReadFile(filepath.Join(dir, "awg0.conf"))
	b3, _ := os.ReadFile(filepath.Join(dir, "awg3.conf"))
	for file, want := range map[string][]string{
		string(b1): {"Address = 10.66.66.1/24, fd5a:1c3e:9b2d:1::1/64\n", "AllowedIPs = 10.66.66.2/32, fd5a:1c3e:9b2d:1::2/128\n"},
		string(b3): {"Address = 10.67.67.1/24, fd5a:1c3e:9b2d:2::1/64\n", "AllowedIPs = 10.67.67.2/32, fd5a:1c3e:9b2d:2::2/128\n", "HeaderProtectionKey = "},
	} {
		for _, w := range want {
			if !strings.Contains(file, w) {
				t.Errorf("misses %q:\n%s", w, file)
			}
		}
	}
	// The single fields of an older panel's device 1 do the same.
	if err := a.AddUser(core.User{UserID: "u2", AmneziaWGPublicKey: testWGPubKeyB,
		AmneziaWGAllowedIP: "10.66.66.3", AmneziaWGAllowedIP6: "fd5a:1c3e:9b2d:1::3",
		AmneziaWGAllowedIP3: "10.67.67.3", AmneziaWGAllowedIP3v6: "fd5a:1c3e:9b2d:2::3"}); err != nil {
		t.Fatal(err)
	}
	b3, _ = os.ReadFile(filepath.Join(dir, "awg3.conf"))
	if !strings.Contains(string(b3), "AllowedIPs = 10.67.67.3/32, fd5a:1c3e:9b2d:2::3/128\n") {
		t.Errorf("awg3 misses the single-field peer:\n%s", b3)
	}
	if fake.count("ip6tables -t nat -S") != 1 {
		t.Errorf("the two interfaces probed apart: %v", fake.sequence())
	}
}

// A state file from before IPv6 (no Address6, no AllowedIP6) is read, and the
// peers are in the memory and the next render.
func TestAStateWrittenBeforeIpv6IsStillRead(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "awg0.conf")
	old := `{"inbound":{"Interface":"awg0","ListenPort":51820,"PrivateKey":"` + testWGPrivKey + `","Address":"10.66.66.1/24",` +
		`"Jc":4,"Jmin":40,"Jmax":70,"S1":72,"S2":56,"S3":32,"S4":16,"H1":100,"H2":200,"H3":300,"H4":400},` +
		`"peerSets":{"u1":[{"PublicKey":"` + testWGPubKeyA + `","AllowedIP":"10.66.66.2/32"}]},` +
		`"peers":{"u1":{"PublicKey":"` + testWGPubKeyA + `","AllowedIP":"10.66.66.2/32"}}}`
	if err := os.WriteFile(strings.TrimSuffix(cfgPath, ".conf")+".state.json", []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	a := installedAdapter(t, cfgPath, &fakeCLI{})
	a.loadState()
	if got := a.peers["u1"]; len(got) != 1 || got[0].AllowedIP != "10.66.66.2/32" || got[0].AllowedIP6 != "" {
		t.Fatalf("peers = %+v", a.peers)
	}
	if a.cfg.Inbound.Address6 != "" {
		t.Errorf("Address6 = %q", a.cfg.Inbound.Address6)
	}
	blob, err := renderConfig(a.cfg.Inbound, sortedPeers(a.peers))
	if err != nil || !strings.Contains(blob, "AllowedIPs = 10.66.66.2/32\n") || !strings.Contains(blob, "Address = 10.66.66.1/24\n") {
		t.Errorf("render of the old state: %v\n%s", err, blob)
	}
}

// A state that carries IPv6 survives an agent restart; and a hand-edited bad
// one is refused peer by peer, like the IPv4 address.
func TestAStateWithIpv6RoundTripsAndABadPeerIsRefused(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "awg0.conf")
	fake := ip6Host(true)
	before := installedAdapter(t, cfgPath, fake)
	if err := before.ApplyInbound(51820, wire6(t, nil)); err != nil {
		t.Fatal(err)
	}
	if err := before.AddUser(core.User{UserID: "u1", AmneziaWGPublicKey: testWGPubKeyA, AmneziaWGAllowedIP: "10.0.0.2", AmneziaWGAllowedIP6: "fd5a:1c3e:9b2d:1::2"}); err != nil {
		t.Fatal(err)
	}
	after := installedAdapter(t, cfgPath, ip6Host(true))
	after.loadState()
	if after.cfg.Inbound.Address6 != test6Server {
		t.Errorf("Address6 after a restart = %q", after.cfg.Inbound.Address6)
	}
	if got := after.peers["u1"]; len(got) != 1 || got[0].AllowedIP6 != test6Peer {
		t.Errorf("peers after a restart = %+v", after.peers)
	}
	if err := validatePeer(Peer{PublicKey: testWGPubKeyA, AllowedIP: "10.0.0.2/32", AllowedIP6: "10.0.0.9/32"}); err == nil {
		t.Error("an IPv4 AllowedIP6 passed validatePeer")
	}
	// AddUser refuses it too, before the peer is kept.
	if err := before.AddUser(core.User{UserID: "u9", AmneziaWGPublicKey: testWGPubKeyC, AmneziaWGAllowedIP: "10.0.0.9", AmneziaWGAllowedIP6: "not-an-ip:"}); err == nil {
		t.Error("a bad IPv6 was kept")
	}
	if _, ok := before.peers["u9"]; ok {
		t.Error("the refused peer is in the map")
	}
}

// A push with no IPv6 fields: nothing in the request, nothing in the files.
func TestWithoutSubnet6NothingChanges(t *testing.T) {
	fake := ip6Host(true)
	a, cfgPath := managed6Adapter(t, fake)
	if err := a.ApplyInbound(51820, wirePayload(t, nil)); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPublicKey: testWGPubKeyA, AmneziaWGAllowedIP: "10.0.0.2"}); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(cfgPath)
	if strings.Contains(string(blob), "ip6tables") || strings.Contains(string(blob), "::") {
		t.Errorf("IPv6 in a config that asked for none:\n%s", blob)
	}
}

func TestBadSubnet6IsRefused(t *testing.T) {
	a, _ := managed6Adapter(t, ip6Host(true))
	for _, bad := range []string{"10.0.0.0/24", "garbage", "fd00::/127"} {
		if err := a.ApplyInbound(51820, wirePayload(t, func(m map[string]any) { m["subnet6"] = bad })); err == nil {
			t.Errorf("subnet6 %q applied", bad)
		}
	}
}

var _ core.AwgIpv6Reporter = (*Adapter)(nil)

// Milestone 18.11: a prefix routed to the node. The peers keep their own
// addresses, so no MASQUERADE for IPv6 and only replies come in.

const test6Real = "2001:db8:77:1::/64"

func TestNoNat6HooksHaveNoIpv6MasqueradeAndLetInOnlyReplies(t *testing.T) {
	in := validInbound()
	base := in.withDefaults()
	in.Address6 = "2001:db8:77:1::1/64"
	in.NoNAT6 = true
	cfg := in.withDefaults()

	// The IPv4 part is the base's, untouched, and first.
	wantLen := len(base.PostUp) + 3
	if len(cfg.PostUp) != wantLen || len(cfg.PostDown) != len(base.PostDown)+3 {
		t.Fatalf("hooks: up %v, down %v", cfg.PostUp, cfg.PostDown)
	}
	for i := range base.PostUp {
		if cfg.PostUp[i] != base.PostUp[i] || cfg.PostDown[i] != base.PostDown[i] {
			t.Errorf("IPv4 hook %d changed: %q / %q", i, cfg.PostUp[i], cfg.PostDown[i])
		}
	}
	up6, down6 := cfg.PostUp[len(base.PostUp):], cfg.PostDown[len(base.PostDown):]
	wantUp := []string{
		"ip6tables -I FORWARD 1 -i %i -j ACCEPT",
		"ip6tables -I FORWARD 2 -o %i -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
		"ip6tables -I FORWARD 3 -o %i -j DROP",
	}
	wantDown := []string{
		"ip6tables -D FORWARD -i %i -j ACCEPT",
		"ip6tables -D FORWARD -o %i -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
		"ip6tables -D FORWARD -o %i -j DROP",
	}
	if strings.Join(up6, "|") != strings.Join(wantUp, "|") || strings.Join(down6, "|") != strings.Join(wantDown, "|") {
		t.Errorf("up %q\ndown %q", up6, down6)
	}
	for _, c := range append(append([]string{}, cfg.PostUp...), cfg.PostDown...) {
		if strings.Contains(c, "ip6tables") && strings.Contains(c, "MASQUERADE") {
			t.Errorf("IPv6 MASQUERADE on a real prefix: %q", c)
		}
		if err := validatePostHook(c); err != nil {
			t.Errorf("%q: %v", c, err)
		}
	}
	// PostDown mirrors PostUp: same match, -D for -I n.
	for i := range up6 {
		mirrored := strings.NewReplacer("-I FORWARD 1", "-D FORWARD", "-I FORWARD 2", "-D FORWARD", "-I FORWARD 3", "-D FORWARD").Replace(up6[i])
		if mirrored != down6[i] {
			t.Errorf("PostDown[%d] %q is not the mirror of %q", i, down6[i], up6[i])
		}
	}
	if _, err := renderConfig(in, nil); err != nil {
		t.Fatalf("render: %v", err)
	}
}

func TestNoNat6WithoutAnIpv6AddressChangesNothing(t *testing.T) {
	in := validInbound()
	base := in.withDefaults()
	in.NoNAT6 = true
	cfg := in.withDefaults()
	if strings.Join(cfg.PostUp, "|") != strings.Join(base.PostUp, "|") || strings.Join(cfg.PostDown, "|") != strings.Join(base.PostDown, "|") {
		t.Errorf("the flag alone changed the hooks: %v / %v", cfg.PostUp, cfg.PostDown)
	}
}

func TestClassifyDiffRestartsOnTheNoNatFlag(t *testing.T) {
	nat := validInbound()
	nat.Address6 = test6Server
	real := nat
	real.NoNAT6 = true
	if got := classifyDiff(nat, real); got != diffRestart {
		t.Errorf("NAT66 -> real = %d", got)
	}
	if got := classifyDiff(real, nat); got != diffRestart {
		t.Errorf("real -> NAT66 = %d", got)
	}
	if got := classifyDiff(real, real); got != diffNone {
		t.Errorf("unchanged = %d", got)
	}
}

// Switching a node from NAT66 to its real prefix with live peers: one restart,
// the same peers, the new hooks; and back.
func TestChangingToARealPrefixWithLivePeersRestartsTheInterfaceAndKeepsThem(t *testing.T) {
	fake := ip6Host(true)
	a, cfgPath := managed6Adapter(t, fake)
	if err := a.ApplyInbound(51820, wire6(t, nil)); err != nil {
		t.Fatal(err)
	}
	for _, u := range []core.User{
		{UserID: "u1", AmneziaWGPublicKey: testWGPubKeyA, AmneziaWGAllowedIP: "10.0.0.2", AmneziaWGAllowedIP6: "fd5a:1c3e:9b2d:1::2"},
		{UserID: "u2", AmneziaWGPublicKey: testWGPubKeyB, AmneziaWGAllowedIP: "10.0.0.3"},
	} {
		if err := a.AddUser(u); err != nil {
			t.Fatal(err)
		}
	}
	downs, ups := fake.count("awg-quick down"), fake.count("awg-quick up")
	real := func(m map[string]any) { m["subnet6"] = test6Real; m["noNat6"] = true }
	if err := a.ApplyInbound(51820, wirePayload(t, real)); err != nil {
		t.Fatalf("the change to a real prefix was refused: %v", err)
	}
	if fake.count("awg-quick down") != downs+1 || fake.count("awg-quick up") != ups+1 {
		t.Errorf("not one restart: %v", fake.sequence())
	}
	blob, _ := os.ReadFile(cfgPath)
	for _, want := range []string{"Address = 10.0.0.1/24, 2001:db8:77:1::1/64", testWGPubKeyA, testWGPubKeyB, "--ctstate RELATED,ESTABLISHED -j ACCEPT", "-o %i -j DROP"} {
		if !strings.Contains(string(blob), want) {
			t.Errorf("config after the restart misses %q:\n%s", want, blob)
		}
	}
	if strings.Contains(string(blob), "ip6tables -t nat -A POSTROUTING") || strings.Contains(string(blob), "fd5a:1c3e:9b2d:1::1") {
		// (The peer's own old v6 stays until the panel re-sends the users, as in 18.10.)
		t.Errorf("NAT66 leftovers after the change:\n%s", blob)
	}
	// Back to NAT66: restart again, the MASQUERADE is back, the peers stay.
	if err := a.ApplyInbound(51820, wire6(t, nil)); err != nil {
		t.Fatal(err)
	}
	blob, _ = os.ReadFile(cfgPath)
	if !strings.Contains(string(blob), "ip6tables -t nat -A POSTROUTING") || strings.Contains(string(blob), "-o %i -j DROP") || !strings.Contains(string(blob), testWGPubKeyB) {
		t.Errorf("after going back:\n%s", blob)
	}
	// The flag without a prefix to carry it is not kept.
	if err := a.ApplyInbound(51820, wirePayload(t, func(m map[string]any) { m["noNat6"] = true })); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(a.cfg.Inbound.Address6, ":") || a.cfg.Inbound.NoNAT6 {
		t.Errorf("flag with no subnet6 stuck: %+v", a.cfg.Inbound)
	}
}

var _ core.AwgNoNat6Reporter = (*Adapter)(nil)

// m18.10 follow-up: ip6tables disappears inside the probe's TTL, a push with
// subnet6 lands in that window, and awg-quick up dies on the first ip6tables
// line (exit 127) after the IPv4 lines already ran. The agent drops the cached
// answer, takes back what PostUp did, and brings the interface up on IPv4 in the
// same apply: no leftover rules, no duplicates on the pushes after it.
func TestIpv6HooksFailingTheUpFallBackToIpv4InTheSameApply(t *testing.T) {
	var (
		cfgPath string
		gone    bool
		rules   = map[string]int{}
		ups     int
		downs   []string
	)
	// exec models iptables/ip6tables over a rule multiset: -I/-A add, -D takes
	// one away and fails when none is there, ip6tables is a 127 once gone.
	exec := func(name string, args []string) error {
		if name == "ip6tables" && gone {
			return errors.New("exit status 127")
		}
		op, key := "", []string{name}
		for _, a := range args {
			switch {
			case a == "-I" || a == "-A" || a == "-D":
				op = a
			case a == "-S":
				return nil
			case a == "1" || a == "2" || a == "3":
			default:
				key = append(key, a)
			}
		}
		k := strings.Join(key, " ")
		if op == "-D" {
			if rules[k] == 0 {
				return errors.New("exit status 1")
			}
			rules[k]--
			return nil
		}
		rules[k]++
		return nil
	}
	hooks := func(prefix string) []string {
		b, _ := os.ReadFile(cfgPath)
		var out []string
		for _, l := range strings.Split(string(b), "\n") {
			if rest, ok := strings.CutPrefix(l, prefix); ok {
				out = append(out, strings.ReplaceAll(rest, "%i", "awg0"))
			}
		}
		return out
	}
	fake := &fakeCLI{handler: func(name string, args []string) ([]byte, error) {
		if name == "awg-quick" && len(args) > 0 {
			switch args[0] {
			case "up":
				ups++
				for _, l := range hooks("PostUp = ") {
					f := strings.Fields(l)
					if err := exec(f[0], f[1:]); err != nil {
						return []byte("awg-quick: line failed"), err
					}
				}
			case "down":
				downs = append(downs, "down")
				for _, l := range hooks("PostDown = ") {
					f := strings.Fields(l)
					_ = exec(f[0], f[1:])
				}
			}
			return nil, nil
		}
		return nil, exec(name, args)
	}}
	a, p := managed6Adapter(t, fake)
	cfgPath = p
	if !a.AwgIpv6() {
		t.Fatal("the probe should have said yes while ip6tables was there")
	}
	gone = true // inside the TTL: the cached answer still says yes

	if err := a.ApplyInbound(51820, wire6(t, nil)); err != nil {
		t.Fatalf("the apply should have come up on IPv4: %v", err)
	}
	if ups != 2 {
		t.Errorf("awg-quick up ran %d times, want the failed one and the IPv4 retry", ups)
	}
	blob, _ := os.ReadFile(cfgPath)
	if strings.Contains(string(blob), "ip6tables") || strings.Contains(string(blob), "fd5a") {
		t.Errorf("the config kept IPv6:\n%s", blob)
	}
	if a.cfg.ip6.checked {
		t.Error("the NAT66 answer was not invalidated")
	}
	want := map[string]int{
		"iptables FORWARD -i awg0 -j ACCEPT":                                 1,
		"iptables FORWARD -o awg0 -j ACCEPT":                                 1,
		"iptables -t nat POSTROUTING -s 10.0.0.0/24 ! -o awg0 -j MASQUERADE": 1,
	}
	check := func(when string) {
		t.Helper()
		for k, n := range rules {
			if n != want[k] {
				t.Errorf("%s: rule %q x%d, want %d", when, k, n, want[k])
			}
		}
		for k, n := range want {
			if rules[k] != n {
				t.Errorf("%s: rule %q x%d, want %d", when, k, rules[k], n)
			}
		}
	}
	check("after the fallback")

	// The same push again: the probe is asked afresh, says no, nothing changes.
	if err := a.ApplyInbound(51820, wire6(t, nil)); err != nil {
		t.Fatal(err)
	}
	check("after the same push")
	// A restart of the IPv4 interface leaves no duplicates either.
	if err := a.ApplyInbound(51821, wire6(t, func(m map[string]any) { m["listenPort"] = 51821 })); err != nil {
		t.Fatal(err)
	}
	check("after a restart")
	for _, c := range fake.sequence() {
		if strings.HasPrefix(c, "ip6tables -t nat -A") {
			t.Errorf("an ip6tables rule was added: %s", c)
		}
	}
}
