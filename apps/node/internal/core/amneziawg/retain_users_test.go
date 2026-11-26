package amneziawg

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// Milestone 9.7: peers of users the panel no longer knows are dropped.

func twoUsersAdapter(t *testing.T) (*Adapter, string) {
	t.Helper()
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "keep", AmneziaWGPeers: twoDevices()[:1]}); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "orphan", AmneziaWGPeers: twoDevices()[1:]}); err != nil {
		t.Fatal(err)
	}
	return a, cfgPath
}

func TestRetainUsers_TheExtraPeerGoesTheNeededStays(t *testing.T) {
	a, cfgPath := twoUsersAdapter(t)
	n, err := a.RetainUsers([]string{"keep"})
	if err != nil || n != 1 {
		t.Fatalf("RetainUsers: n=%d err=%v, want 1", n, err)
	}
	conf := readConf(t, cfgPath)
	if strings.Contains(conf, testWGPubKeyB) || !strings.Contains(conf, testWGPubKeyA) {
		t.Fatalf("wrong peers left:\n%s", conf)
	}
	state := readConf(t, a.statePath())
	if strings.Contains(state, testWGPubKeyB) || !strings.Contains(state, testWGPubKeyA) {
		t.Fatalf("state file not updated:\n%s", state)
	}
	if n, _ := a.RetainUsers([]string{"keep", "unknown"}); n != 0 {
		t.Fatalf("a second pass removed %d", n)
	}
}

func TestRetainUsers_EmptySetRemovesEveryone(t *testing.T) {
	a, cfgPath := twoUsersAdapter(t)
	n, err := a.RetainUsers(nil)
	if err != nil || n != 2 {
		t.Fatalf("n=%d err=%v, want 2", n, err)
	}
	if conf := readConf(t, cfgPath); strings.Contains(conf, "[Peer]") {
		t.Fatalf("peers left:\n%s", conf)
	}
}

func TestRetainUsers_AllDevicesOfAUserGoTogether(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "multi", AmneziaWGPeers: twoDevices()}); err != nil {
		t.Fatal(err)
	}
	n, err := a.RetainUsers([]string{"other"})
	if err != nil || n != 1 {
		t.Fatalf("n=%d err=%v, want one user", n, err)
	}
	if conf := readConf(t, cfgPath); strings.Contains(conf, "[Peer]") {
		t.Fatalf("a device stayed behind:\n%s", conf)
	}
}

// Follow-up to 9.7: what the interface really carries is compared with the
// panel's set, so a peer made by hand (`awg set`) goes too, in place.

const handKey = "HandMadeKeyHandMadeKeyHandMadeKeyHandMade0="

// peersCLI answers `<bin> show <iface> peers` from live[iface] and records the rest.
// A `set ... peer <key> remove` takes the key off the fake interface.
func peersCLI(live map[string][]string) *fakeCLI {
	return &fakeCLI{handler: func(name string, args []string) ([]byte, error) {
		if len(args) == 3 && args[0] == "show" && args[2] == "peers" {
			return []byte(strings.Join(live[args[1]], "\n") + "\n"), nil
		}
		if len(args) == 5 && args[0] == "set" && args[4] == "remove" {
			var rest []string
			for _, k := range live[args[1]] {
				if k != args[3] {
					rest = append(rest, k)
				}
			}
			live[args[1]] = rest
		}
		return nil, nil
	}}
}

func removals(f *fakeCLI) []string {
	var out []string
	for _, s := range f.sequence() {
		if strings.Contains(s, " peer ") && strings.HasSuffix(s, " remove") {
			out = append(out, s)
		}
	}
	return out
}

func TestRetainUsers_HandMadePeerIsRemovedInPlace(t *testing.T) {
	fake := peersCLI(map[string][]string{"awg0": {testWGPubKeyA, handKey}})
	a, _ := newManagedAdapter(t, fake)
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "keep", AmneziaWGPeers: twoDevices()[:1]}); err != nil {
		t.Fatal(err)
	}
	n, err := a.RetainUsers([]string{"keep"})
	if err != nil || n != 1 {
		t.Fatalf("n=%d err=%v, want 1", n, err)
	}
	got := removals(fake)
	if len(got) != 1 || got[0] != "awg set awg0 peer "+handKey+" remove" {
		t.Fatalf("removals: %v", got)
	}
	for _, s := range fake.sequence() {
		if strings.Contains(s, "awg-quick down") || strings.Contains(s, "awg-quick up awg0") && s != fake.sequence()[0] {
			t.Errorf("interface recreated: %s", s)
		}
	}
	if n, _ := a.RetainUsers([]string{"keep"}); n != 0 {
		t.Fatalf("a second pass removed %d", n)
	}
}

func TestRetainUsers_PanelPeersStay(t *testing.T) {
	fake := peersCLI(map[string][]string{"awg0": {testWGPubKeyA, testWGPubKeyB}})
	a, _ := newManagedAdapter(t, fake)
	_ = a.Start(context.Background())
	_ = a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()})
	n, err := a.RetainUsers([]string{"u1"})
	if err != nil || n != 0 || len(removals(fake)) != 0 {
		t.Fatalf("n=%d err=%v removals=%v", n, err, removals(fake))
	}
}

func TestRetainUsers_EmptySetRemovesLivePeersToo(t *testing.T) {
	fake := peersCLI(map[string][]string{"awg0": {handKey}}) // the user's own peer already left through syncconf
	a, _ := newManagedAdapter(t, fake)
	_ = a.Start(context.Background())
	_ = a.AddUser(core.User{UserID: "keep", AmneziaWGPeers: twoDevices()[:1]})
	n, err := a.RetainUsers(nil)
	if err != nil || n != 2 {
		t.Fatalf("n=%d err=%v, want the user plus the hand-made peer", n, err)
	}
	if got := removals(fake); len(got) != 1 {
		t.Fatalf("removals: %v", got)
	}
}

func TestRetainUsers_ListingFailureOrConfigOnlyRemovesNothing(t *testing.T) {
	fake := &fakeCLI{handler: func(name string, args []string) ([]byte, error) {
		if len(args) > 0 && args[0] == "show" {
			return nil, errors.New("exit status 1")
		}
		return nil, nil
	}}
	a, _ := newManagedAdapter(t, fake)
	_ = a.Start(context.Background())
	if n, err := a.RetainUsers(nil); n != 0 || err != nil || len(removals(fake)) != 0 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	a2, _ := newTestAdapter(t) // config-only: no AwgBin
	_ = a2.Start(context.Background())
	if n, err := a2.RetainUsers(nil); n != 0 || err != nil {
		t.Fatalf("config-only: n=%d err=%v", n, err)
	}
}

func TestRetainUsers_PerInterfaceAwg0Awg3Wg0(t *testing.T) {
	fake := peersCLI(map[string][]string{
		"awg0": {testWGPubKeyA, "H0H0H0H0H0H0H0H0H0H0H0H0H0H0H0H0H0H0H0H0H0H="},
		"awg3": {testWGPubKeyA, "H3H3H3H3H3H3H3H3H3H3H3H3H3H3H3H3H3H3H3H3H3H="},
		"wg0":  {testWGPubKeyC, "HWHWHWHWHWHWHWHWHWHWHWHWHWHWHWHWHWHWHWHWHWH="},
	})
	a, _ := newManagedAdapter(t, fake)
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.v3.cfg.Inbound = validInbound()
	a.v3.cfg.Inbound.Interface = V3Interface
	a.v3.cfg.Inbound.Address = "10.88.88.1/24"
	a.v3.started = true
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: []core.AmneziaWGPeer{
		{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2", AllowedIP3: "10.88.88.2"}}}); err != nil {
		t.Fatal(err)
	}
	w := newPlainAdapter(t, t.TempDir(), fake)
	if err := w.ApplyInbound(51899, plainWire(t, nil)); err != nil {
		t.Fatalf("plain ApplyInbound: %v", err)
	}
	if err := w.AddUser(plainUser("u1", testWGPubKeyC, "10.77.77.2")); err != nil {
		t.Fatal(err)
	}
	na, _ := a.RetainUsers([]string{"u1"})
	nw, _ := w.RetainUsers([]string{"u1"})
	if na != 2 || nw != 1 {
		t.Fatalf("awg removed %d (want awg0+awg3), wg removed %d", na, nw)
	}
	var got []string
	for _, r := range removals(fake) {
		got = append(got, r[:strings.Index(r, " peer ")]+" "+r[strings.Index(r, " peer ")+6:][:4])
	}
	want := []string{"awg set awg0 H0H0", "awg set awg3 H3H3", "wg set wg0 HWHW"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %v want %v", got, want)
	}
}
