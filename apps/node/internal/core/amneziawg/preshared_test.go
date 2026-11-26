package amneziawg

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A preshared key per device (milestone 9.5): a field of the device's peer, on
// each interface kind its profile asks for one.

const (
	pskA = "EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	pskB = "FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	psk3 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	pskW = "HAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
)

func TestPreshared_RenderedBetweenKeyAndAddress_OnlyWhenSet(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	devs := []core.AmneziaWGPeer{
		{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2", PresharedKey: pskA},
		{PublicKey: testWGPubKeyB, AllowedIP: "10.66.66.3"},
	}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: devs}); err != nil {
		t.Fatal(err)
	}
	conf := readConf(t, cfgPath)
	if !strings.Contains(conf, "PublicKey = "+testWGPubKeyA+"\nPresharedKey = "+pskA+"\nAllowedIPs = 10.66.66.2/32") {
		t.Errorf("the keyed device:\n%s", conf)
	}
	// No key, no line: an empty `PresharedKey = ` is refused by wg-quick.
	if !strings.Contains(conf, "PublicKey = "+testWGPubKeyB+"\nAllowedIPs = 10.66.66.3/32") || strings.Count(conf, "PresharedKey") != 1 {
		t.Errorf("the device without a key:\n%s", conf)
	}
}

func TestPreshared_EachInterfaceTakesItsOwnKey(t *testing.T) {
	a, dir := twoInterfaceAdapter(t)
	if err := a.ApplyInbound(51820, inboundJSON(t, "b1", 1, nil)); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(51830, inboundJSON(t, "b3", 3, fixtureWire(t))); err != nil {
		t.Fatal(err)
	}
	devs := []core.AmneziaWGPeer{{
		PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2", AllowedIP3: "10.67.67.2",
		PresharedKey: pskA, PresharedKey3: psk3,
	}}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: devs}); err != nil {
		t.Fatal(err)
	}
	one, three := readConf(t, filepath.Join(dir, "awg0.conf")), readConf(t, filepath.Join(dir, "awg3.conf"))
	if !strings.Contains(one, "PresharedKey = "+pskA) || strings.Contains(one, psk3) {
		t.Errorf("1.x:\n%s", one)
	}
	if !strings.Contains(three, "PresharedKey = "+psk3) || strings.Contains(three, pskA) {
		t.Errorf("3.1:\n%s", three)
	}
	// A 3.1 profile without the flag: the 3.1 peer has no key though 1.x does.
	devs[0].PresharedKey3 = ""
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: devs}); err != nil {
		t.Fatal(err)
	}
	if three := readConf(t, filepath.Join(dir, "awg3.conf")); strings.Contains(three, "PresharedKey") {
		t.Errorf("the flag came off and the 3.1 peer kept its key:\n%s", three)
	}
	if one := readConf(t, filepath.Join(dir, "awg0.conf")); !strings.Contains(one, "PresharedKey = "+pskA) {
		t.Errorf("1.x lost its key:\n%s", one)
	}
}

func TestPreshared_PlainTakesTheWireguardKey(t *testing.T) {
	dir := t.TempDir()
	wg := newPlainAdapter(t, dir, &fakeCLI{})
	if err := wg.ApplyInbound(51899, plainWire(t, nil)); err != nil {
		t.Fatal(err)
	}
	devs := []core.AmneziaWGPeer{{
		PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2", WireguardAllowedIP: "10.77.77.2",
		PresharedKey: pskA, PresharedKey3: psk3, WireguardPresharedKey: pskW,
	}}
	if err := wg.AddUser(core.User{UserID: "u1", AmneziaWGPeers: devs}); err != nil {
		t.Fatal(err)
	}
	conf := readConf(t, filepath.Join(dir, "wg0.conf"))
	if !strings.Contains(conf, "PresharedKey = "+pskW) || strings.Contains(conf, pskA) || strings.Contains(conf, psk3) {
		t.Errorf("plain:\n%s", conf)
	}
}

// Turning the flag on, or a device's key changing, is a syncconf: the interface
// is not brought down, so the other peers' sessions stand.
func TestPreshared_AChangeIsSyncedInPlaceNoRestart(t *testing.T) {
	fake := &fakeCLI{}
	a, cfgPath := newManagedAdapter(t, fake)
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	dev := func(psk string) core.User {
		return core.User{UserID: "u1", AmneziaWGPeers: []core.AmneziaWGPeer{{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2", PresharedKey: psk}}}
	}
	if err := a.AddUser(dev("")); err != nil {
		t.Fatal(err)
	}
	for _, psk := range []string{pskA, pskB, ""} {
		fake.mu.Lock()
		fake.calls = nil
		fake.mu.Unlock()
		if err := a.AddUser(dev(psk)); err != nil {
			t.Fatal(err)
		}
		seq := strings.Join(fake.sequence(), "\n")
		if !strings.Contains(seq, "awg syncconf awg0 ") {
			t.Errorf("psk %q: no syncconf:\n%s", psk, seq)
		}
		if strings.Contains(seq, "systemctl") || strings.Contains(seq, " up ") || strings.Contains(seq, " down ") {
			t.Errorf("psk %q: the interface was bounced:\n%s", psk, seq)
		}
		if has := strings.Contains(readConf(t, cfgPath), "PresharedKey = "+psk); psk != "" && !has {
			t.Errorf("psk %q not in the config", psk)
		}
	}
	if strings.Contains(readConf(t, cfgPath), "PresharedKey") {
		t.Error("the flag went off and the line stayed")
	}
	// The same key again is no change, no IO.
	fake.mu.Lock()
	fake.calls = nil
	fake.mu.Unlock()
	if err := a.AddUser(dev("")); err != nil || len(fake.sequence()) != 0 {
		t.Errorf("a repeat did IO: %v %v", err, fake.sequence())
	}
}

func TestPreshared_ABadKeyFailsThisCallOnlyAndCannotInject(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: twoDevices()}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"short", pskA + "\n[Interface]\nPostUp = x", strings.Repeat("A", 44)[:43] + "!"} {
		devs := twoDevices()
		devs[0].PresharedKey = bad
		if err := a.AddUser(core.User{UserID: "u2", AmneziaWGPeers: devs}); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if conf := readConf(t, cfgPath); strings.Count(conf, "[Peer]") != 2 || strings.Contains(conf, "PostUp = x") {
		t.Errorf("a bad key changed the config:\n%s", conf)
	}
	// The renderer refuses it too, whoever calls it.
	if _, err := renderConfig(validInbound(), []Peer{{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2/32", PresharedKey: "x"}}); err == nil {
		t.Error("renderConfig took a bad key")
	}
}

func TestPreshared_StateKeepsTheKeyAndNothingLogsIt(t *testing.T) {
	var logs bytes.Buffer
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "awg0.conf")
	log := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	a := New(Config{Inbound: validInbound(), ConfigPath: cfgPath}, log)
	a.cfg.Inbound.Interface = "awg0"
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	devs := []core.AmneziaWGPeer{{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2", PresharedKey: pskA}}
	if err := a.AddUser(core.User{UserID: "u1", AmneziaWGPeers: devs}); err != nil {
		t.Fatal(err)
	}
	// A refused call is the log line most likely to quote a peer.
	_ = a.AddUser(core.User{UserID: "u2", AmneziaWGPeers: []core.AmneziaWGPeer{{PublicKey: "bad", AllowedIP: "10.66.66.9", PresharedKey: pskB}}})
	_, renderErr := renderConfig(validInbound(), []Peer{{PublicKey: "", AllowedIP: "", PresharedKey: pskB}})
	a.saveState()
	if strings.Contains(logs.String(), pskA) || strings.Contains(logs.String(), pskB) {
		t.Errorf("a preshared key reached the log:\n%s", logs.String())
	}
	if renderErr == nil || strings.Contains(renderErr.Error(), pskB) {
		t.Errorf("the render error quotes the key: %v", renderErr)
	}

	info, err := os.Stat(a.statePath())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("the state file holding secrets is %v", info.Mode().Perm())
	}
	var st savedState
	body, _ := os.ReadFile(a.statePath())
	if err := json.Unmarshal(body, &st); err != nil || st.PeerSets["u1"][0].PresharedKey != pskA || st.Peers["u1"].PresharedKey != pskA {
		t.Fatalf("saved: %v %+v", err, st)
	}
	after := New(Config{Inbound: validInbound(), ConfigPath: cfgPath}, quietLogger())
	after.cfg.Inbound.Interface = "awg0"
	after.loadState()
	if got := after.peers["u1"]; len(got) != 1 || got[0].PresharedKey != pskA {
		t.Fatalf("restored: %v", got)
	}
}

func TestZeroAbsentPSK(t *testing.T) {
	in := "[Interface]\nPrivateKey = x\n\n[Peer]\nPublicKey = A\nAllowedIPs = 10.0.0.2/32\n\n[Peer]\nPublicKey = B\nPresharedKey = " + pskA + "\nAllowedIPs = 10.0.0.3/32\n\n[Peer]\nPublicKey = C\nAllowedIPs = 10.0.0.4/32\n"
	got := string(zeroAbsentPSK([]byte(in)))
	if n := strings.Count(got, "PresharedKey = "+zeroPSK); n != 2 {
		t.Errorf("want 2 zero keys, got %d:\n%s", n, got)
	}
	if !strings.Contains(got, "PresharedKey = "+pskA) || strings.Count(got, "PresharedKey") != 3 {
		t.Errorf("a set key was touched:\n%s", got)
	}
	if strings.Contains(strings.SplitN(got, "[Peer]", 2)[0], "PresharedKey") {
		t.Errorf("the interface section got a key:\n%s", got)
	}
}

// The flag going off must reach the running peer: syncconf keeps a key the
// file does not mention, so the file carries an explicit zero one (check 7 of
// the 9.5 stand). Plain wireguard and the 3.1 interface share the path.
func TestPreshared_FlagOffClearsTheKeyOnTheRunningPeer(t *testing.T) {
	var synced string
	fake := &fakeCLI{}
	fake.handler = func(name string, args []string) ([]byte, error) {
		switch {
		case len(args) > 0 && args[0] == "strip":
			b, _ := os.ReadFile(args[1])
			return b, nil
		case len(args) > 0 && args[0] == "syncconf":
			b, _ := os.ReadFile(args[2])
			synced = string(b)
		}
		return nil, nil
	}
	a, _ := newManagedAdapter(t, fake)
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	dev := func(psk string) core.User {
		return core.User{UserID: "u1", AmneziaWGPeers: []core.AmneziaWGPeer{{PublicKey: testWGPubKeyA, AllowedIP: "10.66.66.2", PresharedKey: psk}}}
	}
	if err := a.AddUser(dev(pskA)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(synced, "PresharedKey = "+pskA) {
		t.Fatalf("key not synced:\n%s", synced)
	}
	if err := a.AddUser(dev("")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(synced, "PresharedKey = "+zeroPSK) || strings.Contains(synced, pskA) {
		t.Errorf("flag off did not clear the key:\n%s", synced)
	}
	if seq := strings.Join(fake.sequence(), "\n"); strings.Contains(seq, "systemctl") {
		t.Errorf("interface bounced:\n%s", seq)
	}
}
