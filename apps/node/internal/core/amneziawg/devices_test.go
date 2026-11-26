package amneziawg

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A user holds a peer per device (milestone 9.4): each its own key and address.
// The panel sends the whole list every time, under the user's one identifier.

func devicesAdapter(t *testing.T) (*Adapter, string) {
	t.Helper()
	a, cfgPath := newTestAdapter(t)
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	return a, cfgPath
}

func readConf(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func twoDevices() []core.AmneziaWGPeer {
	return []core.AmneziaWGPeer{
		{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2"},
		{PublicKey: testWGPubKeyB, AllowedIP: "10.66.66.3"},
	}
}

func TestDevices_EachDeviceIsItsOwnPeer(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()}); err != nil {
		t.Fatal(err)
	}
	conf := readConf(t, cfgPath)
	if n := strings.Count(conf, "[Peer]"); n != 2 {
		t.Fatalf("want 2 peers, got %d:\n%s", n, conf)
	}
	for _, want := range []string{
		"PublicKey = " + testWGPubKeyA + "\nAllowedIPs = 10.66.66.2/32",
		"PublicKey = " + testWGPubKeyB + "\nAllowedIPs = 10.66.66.3/32",
	} {
		if !strings.Contains(conf, want) {
			t.Errorf("missing %q:\n%s", want, conf)
		}
	}
}

func TestDevices_ASmallerListTakesTheRestOff_RemoveUserTakesAll(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()}); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()[1:]}); err != nil {
		t.Fatal(err)
	}
	conf := readConf(t, cfgPath)
	if strings.Contains(conf, testWGPubKeyA) || !strings.Contains(conf, testWGPubKeyB) {
		t.Fatalf("the dropped device is still there, or the other gone:\n%s", conf)
	}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()}); err != nil {
		t.Fatal(err)
	}
	if err := a.RemoveUser("u1"); err != nil {
		t.Fatal(err)
	}
	if conf := readConf(t, cfgPath); strings.Contains(conf, "[Peer]") {
		t.Fatalf("RemoveUser left a device behind:\n%s", conf)
	}
}

func TestDevices_AnEmptyListTakesTheUserOff_AnOldPanelsSilenceDoesNot(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()}); err != nil {
		t.Fatal(err)
	}
	// A record without amneziawg fields (an older panel, a non-WG user): no change.
	if err := a.AddUser(core.User{UserID: "u1"}); err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(readConf(t, cfgPath), "[Peer]"); n != 2 {
		t.Fatalf("a record without amneziawg fields changed the peers: %d left", n)
	}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: []core.AmneziaWGPeer{}}); err != nil {
		t.Fatal(err)
	}
	if conf := readConf(t, cfgPath); strings.Contains(conf, "[Peer]") {
		t.Fatalf("an empty device list left peers behind:\n%s", conf)
	}
}

func TestDevices_TheListWinsOverTheSingleFields(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	// The panel fills the single fields with device 1 for older agents.
	u := core.User{UserID: "u1", AmneziaWGPublicKey: testWGPubKeyA, AmneziaWGAllowedIP: "10.66.66.2", AmneziaWGPeers: twoDevices()}
	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(readConf(t, cfgPath), "[Peer]"); n != 2 {
		t.Fatalf("want the two devices, got %d peers", n)
	}
	// An older panel (no list): the single fields are the one peer, as before.
	if err := a.AddUser(core.User{UserID: "u2", AmneziaWGPublicKey: testWGPubKeyC, AmneziaWGAllowedIP: "10.66.66.9"}); err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(readConf(t, cfgPath), "[Peer]"); n != 3 {
		t.Fatalf("a record of an older panel: %d peers, want 3", n)
	}
}

func TestDevices_ABadKeyFailsThisCallOnly(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "u2", AmneziaWGPeers: []core.AmneziaWGPeer{{PublicKey: testWGPubKeyC, AllowedIP: "10.66.66.9"}}}); err != nil {
		t.Fatal(err)
	}
	bad := twoDevices()
	bad[1].PublicKey = "not-a-key"
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: bad}); err == nil {
		t.Fatal("want an error for a bad key")
	}
	if conf := readConf(t, cfgPath); strings.Contains(conf, testWGPubKeyA) || !strings.Contains(conf, testWGPubKeyC) {
		t.Fatalf("the refused user got in (even the good device), or another user was lost:\n%s", conf)
	}
}

func TestDevices_OnBothInterfacesByTheirOwnAddress(t *testing.T) {
	a, _ := twoInterfaceAdapter(t)
	if err := a.ApplyInbound(51820, inboundJSON(t, "b1", 1, nil)); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(51830, inboundJSON(t, "b3", 3, fixtureWire(t))); err != nil {
		t.Fatal(err)
	}
	devs := []core.AmneziaWGPeer{
		{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2", AllowedIP3: "10.67.67.2"},
		{PublicKey: testWGPubKeyB, AllowedIP: "10.66.66.3"}, // no 3.1 address yet
	}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: devs}); err != nil {
		t.Fatal(err)
	}
	if got := a.peers["u1"]; len(got) != 2 {
		t.Fatalf("1.x: %v", got)
	}
	if got := a.v3.peers["u1"]; len(got) != 1 || got[0].PublicKey != testWGPubKeyA || got[0].AllowedIP != "10.67.67.2/32" {
		t.Fatalf("3.1: %v", got)
	}
	// Scoped to the 1.x inbound only: off the 3.1 interface, kept on 1.x.
	if err := a.AddUserOn(core.User{UserID: "u1", AmneziaWGPeers: devs}, []string{"b1"}); err != nil {
		t.Fatal(err)
	}
	if _, on3 := a.v3.peers["u1"]; on3 || len(a.peers["u1"]) != 2 {
		t.Fatalf("scoped to 1.x: 1.x %v, 3.1 %v", a.peers["u1"], a.v3.peers["u1"])
	}
	// Scoped to the 3.1 inbound only: off 1.x, the one device with a 3.1 address on 3.1.
	if err := a.AddUserOn(core.User{UserID: "u1", AmneziaWGPeers: devs}, []string{"b3"}); err != nil {
		t.Fatal(err)
	}
	if _, on1 := a.peers["u1"]; on1 || len(a.v3.peers["u1"]) != 1 {
		t.Fatalf("scoped to 3.1: 1.x %v, 3.1 %v", a.peers["u1"], a.v3.peers["u1"])
	}
	// The caller's list is not rewritten by the scoping.
	if devs[0].AllowedIP != "10.66.66.2" || devs[0].AllowedIP3 != "10.67.67.2" {
		t.Fatalf("AddUserOn changed the caller's devices: %+v", devs)
	}
}

func TestDevices_PlainTakesTheWireguardAddressOfEachDevice(t *testing.T) {
	dir := t.TempDir()
	wg := newPlainAdapter(t, dir, &fakeCLI{})
	if err := wg.ApplyInbound(51899, plainWire(t, nil)); err != nil {
		t.Fatal(err)
	}
	devs := []core.AmneziaWGPeer{
		{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2", WireguardAllowedIP: "10.77.77.2"},
		{PublicKey: testWGPubKeyB, AllowedIP: "10.66.66.3", WireguardAllowedIP: "10.77.77.3"},
	}
	if err := wg.AddUser(core.User{UserID: "u1", AmneziaWGPeers: devs}); err != nil {
		t.Fatal(err)
	}
	conf := readConf(t, filepath.Join(dir, "wg0.conf"))
	if strings.Count(conf, "[Peer]") != 2 || !strings.Contains(conf, "10.77.77.3/32") || strings.Contains(conf, "10.66.66") {
		t.Fatalf("plain peers:\n%s", conf)
	}
	// A device without a plain address is not a peer of this interface.
	devs[1].WireguardAllowedIP = ""
	if err := wg.AddUser(core.User{UserID: "u1", AmneziaWGPeers: devs}); err != nil {
		t.Fatal(err)
	}
	if conf := readConf(t, filepath.Join(dir, "wg0.conf")); strings.Count(conf, "[Peer]") != 1 {
		t.Fatalf("a device with no plain address stayed on wg0:\n%s", conf)
	}
}

func TestDevices_StatsBillTheUserTheSumOfItsDevices(t *testing.T) {
	dir := t.TempDir()
	dump := "srv\tpsk\t51820\toff\n" +
		testWGPubKeyA + "\t(none)\t1.2.3.4:5\t10.66.66.2/32\t0\t1000\t100\t0\n" +
		testWGPubKeyB + "\t(none)\t1.2.3.5:5\t10.66.66.3/32\t0\t2000\t200\t0\n"
	a := New(Config{
		Inbound:     validInbound(),
		ConfigPath:  filepath.Join(dir, "awg0.conf"),
		AwgBin:      "/usr/bin/awg",
		AwgQuickBin: "/usr/bin/awg-quick",
	}, quietLogger())
	a.cfg.runCmd = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "show" {
			return []byte(dump), nil
		}
		return nil, nil
	}
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.GetStats(); err != nil { // first sight: baselines
		t.Fatal(err)
	}
	dump = strings.Replace(strings.Replace(dump, "1000\t100", "1500\t130", 1), "2000\t200", "2010\t205", 1)
	st, err := a.GetStats()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Users) != 1 {
		t.Fatalf("one user, two devices: %+v", st.Users)
	}
	if u := st.Users[0]; u.BytesIn != 510 || u.BytesOut != 35 {
		t.Errorf("user sum: %d/%d, want 510/35", u.BytesIn, u.BytesOut)
	}
}

func TestDevices_StateKeepsEveryDeviceAndReadsTheOldFile(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()}); err != nil {
		t.Fatal(err)
	}
	a.saveState()
	body, err := os.ReadFile(a.statePath())
	if err != nil {
		t.Fatal(err)
	}
	var st savedState
	if err := json.Unmarshal(body, &st); err != nil {
		t.Fatal(err)
	}
	if len(st.PeerSets["u1"]) != 2 || st.Peers["u1"].PublicKey != testWGPubKeyA {
		t.Fatalf("saved: sets %v, single %v", st.PeerSets, st.Peers)
	}

	after := New(Config{Inbound: validInbound(), ConfigPath: cfgPath}, quietLogger())
	after.cfg.Inbound.Interface = "awg0"
	after.loadState()
	if got := after.peers["u1"]; len(got) != 2 || got[0].PublicKey != testWGPubKeyA {
		t.Fatalf("restored: %v", got)
	}

	// A file an agent older than devices wrote: one peer per user, no peerSets.
	st.PeerSets = nil
	old, _ := json.Marshal(st)
	if err := os.WriteFile(a.statePath(), old, 0o600); err != nil {
		t.Fatal(err)
	}
	older := New(Config{Inbound: validInbound(), ConfigPath: cfgPath}, quietLogger())
	older.cfg.Inbound.Interface = "awg0"
	older.loadState()
	if got := older.peers["u1"]; len(got) != 1 || got[0].PublicKey != testWGPubKeyA {
		t.Fatalf("old file: %v", got)
	}
}

// A file written by this agent still has the old "peers" field, one per user,
// so a rolled-back agent comes up with device 1 rather than nobody.
func TestDevices_TheStateFileStaysReadableByTheOldAgent(t *testing.T) {
	a, _ := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()}); err != nil {
		t.Fatal(err)
	}
	a.saveState()
	body, _ := os.ReadFile(a.statePath())
	var old struct {
		Peers map[string]Peer `json:"peers"`
	}
	if err := json.Unmarshal(body, &old); err != nil {
		t.Fatal(err)
	}
	if p := old.Peers["u1"]; p.PublicKey != testWGPubKeyA || p.AllowedIP != "10.66.66.2/32" {
		t.Fatalf("the old field: %+v", old.Peers)
	}
}

// Per-device counters (milestone 9.6): one entry per peer under the user, by
// key, with the latest handshake; the user's entry is their sum.
func TestAdapter_GetStats_PeersByKeyAndHandshake(t *testing.T) {
	dump := func(rxA, rxB string) string {
		return "srv-priv\tsrv-pub\t1234\toff\n" +
			testWGPubKeyA + "\t(none)\t1.2.3.4:5\t10.66.66.2/32\t1778646563\t" + rxA + "\t100\t25\n" +
			testWGPubKeyB + "\t(none)\t(none)\t10.66.66.3/32\t0\t" + rxB + "\t0\toff\n"
	}
	cur := dump("1000", "0")
	a, _ := newTestAdapter(t)
	a.cfg.AwgBin = "/usr/bin/awg"
	a.cfg.runCmd = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "show" {
			return []byte(cur), nil
		}
		return nil, nil
	}
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: []core.AmneziaWGPeer{
		{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2/32"},
		{PublicKey: testWGPubKeyB, AllowedIP: "10.66.66.3/32"},
	}}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.GetStats(); err != nil { // baseline
		t.Fatal(err)
	}
	cur = dump("1600", "50")
	st, err := a.GetStats()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Users) != 1 || len(st.Users[0].Peers) != 2 {
		t.Fatalf("want one user with two peers, got %+v", st.Users)
	}
	u := st.Users[0]
	if u.BytesIn != 650 || u.BytesOut != 0 {
		t.Errorf("user sum %d/%d, want 650/0", u.BytesIn, u.BytesOut)
	}
	pa, pb := u.Peers[0], u.Peers[1]
	if pa.PublicKey != testWGPubKeyA || pa.BytesIn != 600 || pa.LastHandshake != 1778646563 {
		t.Errorf("peer A %+v", pa)
	}
	if pb.PublicKey != testWGPubKeyB || pb.BytesIn != 50 || pb.LastHandshake != 0 {
		t.Errorf("peer B %+v", pb)
	}
}

func TestParseAwgDump_Handshakes(t *testing.T) {
	_, _, hs := parseAwgDump(fakeAwgDump)
	if hs[testWGPubKeyA] != 1778646563 {
		t.Errorf("handshake A = %d", hs[testWGPubKeyA])
	}
	if _, ok := hs[testWGPubKeyB]; ok {
		t.Errorf("a peer with no handshake should be absent")
	}
}

// The same device on both interfaces is one device: bytes add, the later
// handshake stands.
func TestMergePeers_SameKeyAcrossInterfaces(t *testing.T) {
	got := mergePeers(
		[]core.PeerStats{{PublicKey: "k1", BytesIn: 1, BytesOut: 2, LastHandshake: 10}},
		[]core.PeerStats{{PublicKey: "k1", BytesIn: 4, BytesOut: 8, LastHandshake: 30}, {PublicKey: "k2", BytesIn: 5}},
	)
	if len(got) != 2 || got[0].BytesIn != 5 || got[0].BytesOut != 10 || got[0].LastHandshake != 30 || got[1].PublicKey != "k2" {
		t.Errorf("merged %+v", got)
	}
}
