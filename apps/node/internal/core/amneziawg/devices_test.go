package amneziawg

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A user holds a peer per device: each its own key, address and, when the
// profile asks, preshared key. The panel sends the whole list every time.

const testPSK = "EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

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
		{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2", PresharedKey: testPSK},
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
	if !strings.Contains(conf, "PublicKey = "+testWGPubKeyA+"\nPresharedKey = "+testPSK+"\nAllowedIPs = 10.66.66.2/32") {
		t.Errorf("device 1 without its preshared key:\n%s", conf)
	}
	if !strings.Contains(conf, "PublicKey = "+testWGPubKeyB+"\nAllowedIPs = 10.66.66.3/32") {
		t.Errorf("device 2 (no preshared key) rendered wrong:\n%s", conf)
	}
}

func TestDevices_ARevokedDeviceLeavesTheOthers(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()}); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()[1:]}); err != nil {
		t.Fatal(err)
	}
	conf := readConf(t, cfgPath)
	if strings.Contains(conf, testWGPubKeyA) || !strings.Contains(conf, testWGPubKeyB) {
		t.Fatalf("revoked device still there, or the other gone:\n%s", conf)
	}
}

func TestDevices_AnEmptyListTakesTheUserOff_AnOldPanelsSilenceDoesNot(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()}); err != nil {
		t.Fatal(err)
	}
	// An older panel's record without amneziawg fields: no change.
	if err := a.AddUser(core.User{UserID: "u1"}); err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(readConf(t, cfgPath), "[Peer]"); n != 2 {
		t.Fatalf("a record without amneziawg fields changed the peers: %d left", n)
	}
	// The panel saying "no device": every peer of the user goes.
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
}

func TestDevices_ABadPresharedKeyFailsThisCallOnly(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "u2", AmneziaWGPeers: []core.AmneziaWGPeer{{PublicKey: testWGPubKeyC, AllowedIP: "10.66.66.9"}}}); err != nil {
		t.Fatal(err)
	}
	bad := twoDevices()
	bad[0].PresharedKey = "not-a-key"
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: bad}); err == nil || !strings.Contains(err.Error(), "preshared key") {
		t.Fatalf("want a preshared key error, got %v", err)
	}
	if conf := readConf(t, cfgPath); strings.Contains(conf, testWGPubKeyA) || !strings.Contains(conf, testWGPubKeyC) {
		t.Fatalf("the refused user got in, or another user was lost:\n%s", conf)
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
		{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2", AllowedIP3: "10.67.67.2", PresharedKey3: testPSK},
		{PublicKey: testWGPubKeyB, AllowedIP: "10.66.66.3"}, // no 3.1 address yet
	}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: devs}); err != nil {
		t.Fatal(err)
	}
	if got := a.peers["u1"]; len(got) != 2 {
		t.Fatalf("1.x: %v", got)
	}
	if got := a.peers["u1"]; got[0].PresharedKey != "" {
		t.Fatalf("1.x took the 3.1 preshared key: %v", got)
	}
	if got := a.v3.peers["u1"]; len(got) != 1 || got[0].PublicKey != testWGPubKeyA || got[0].AllowedIP != "10.67.67.2/32" || got[0].PresharedKey != testPSK {
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
}

func TestDevices_StatsBillTheUserTheSumAndNameEachDevice(t *testing.T) {
	dir := t.TempDir()
	dump := "srv\tpsk\t51820\toff\n" +
		testWGPubKeyA + "\t(none)\t1.2.3.4:5\t10.66.66.2/32\t0\t1000\t100\t0\n" +
		testWGPubKeyB + "\t(none)\t1.2.3.5:5\t10.66.66.3/32\t0\t2000\t200\t0\n"
	a := New(Config{
		Inbound:     validInbound(),
		ConfigPath:  filepath.Join(dir, "awg0.conf"),
		AwgBin:      "/usr/bin/awg",
		AwgQuickBin: "/usr/bin/awg-quick",
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
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
	u := st.Users[0]
	if u.BytesIn != 510 || u.BytesOut != 35 {
		t.Errorf("user sum: %d/%d, want 510/35", u.BytesIn, u.BytesOut)
	}
	byKey := map[string]core.PeerStats{}
	for _, p := range u.Peers {
		byKey[p.PublicKey] = p
	}
	if p := byKey[testWGPubKeyA]; p.BytesIn != 500 || p.BytesOut != 30 {
		t.Errorf("device A: %+v", p)
	}
	if p := byKey[testWGPubKeyB]; p.BytesIn != 10 || p.BytesOut != 5 {
		t.Errorf("device B: %+v", p)
	}
}

func TestDevices_MergeStatsSumsADeviceOnBothInterfaces(t *testing.T) {
	a := &core.Stats{Users: []core.UserStats{{UserID: "u1", BytesIn: 10, BytesOut: 1, Peers: []core.PeerStats{{PublicKey: "k1", BytesIn: 10, BytesOut: 1}}}}}
	b := &core.Stats{Users: []core.UserStats{{UserID: "u1", BytesIn: 7, BytesOut: 2, Peers: []core.PeerStats{{PublicKey: "k1", BytesIn: 5, BytesOut: 2}, {PublicKey: "k2", BytesIn: 2}}}}}
	got := mergeStats(a, b).Users[0]
	if got.BytesIn != 17 || len(got.Peers) != 2 || got.Peers[0].BytesIn != 15 || got.Peers[1].BytesIn != 2 {
		t.Fatalf("merged: %+v", got)
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

	after := New(Config{Inbound: validInbound(), ConfigPath: cfgPath}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	after.cfg.Inbound.Interface = "awg0"
	after.loadState()
	if got := after.peers["u1"]; len(got) != 2 || got[0].PresharedKey != testPSK {
		t.Fatalf("restored: %v", got)
	}

	// A file an agent older than devices wrote: one peer per user.
	st.PeerSets = nil
	old, _ := json.Marshal(st)
	if err := os.WriteFile(a.statePath(), old, 0o600); err != nil {
		t.Fatal(err)
	}
	older := New(Config{Inbound: validInbound(), ConfigPath: cfgPath}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	older.cfg.Inbound.Interface = "awg0"
	older.loadState()
	if got := older.peers["u1"]; len(got) != 1 || got[0].PublicKey != testWGPubKeyA {
		t.Fatalf("old file: %v", got)
	}
}
