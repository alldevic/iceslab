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
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// Plain WireGuard (milestone 9.1): this package's adapter in plain mode, on
// wg / wg-quick, beside the AmneziaWG instance. The tests drive it the way
// awg_cli_test.go drives AmneziaWG: a recording runner, no binaries.

func plainInbound() InboundConfig {
	return InboundConfig{PrivateKey: testWGPrivKey, Address: "10.77.77.1/24"}
}

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// newPlainAdapter is what main.go builds for WIREGUARD_BIN: the CLIs and the
// interface, nothing else until the first push.
func newPlainAdapter(t *testing.T, dir string, fake *fakeCLI) *Adapter {
	t.Helper()
	return New(Config{
		Protocol:     NameWireguard,
		ConfigPath:   filepath.Join(dir, "wg0.conf"),
		AwgBin:       "wg",
		AwgQuickBin:  "wg-quick",
		SystemctlBin: "systemctl",
		SyncTimeout:  500 * time.Millisecond,
		runCmd:       fake.run,
	}, quietLogger())
}

func plainWire(t *testing.T, extra map[string]any) json.RawMessage {
	t.Helper()
	m := map[string]any{
		"subnet":           "10.77.77.0/24",
		"serverPrivateKey": testWGPrivKey,
		"serverPublicKey":  testWGPubKeyC,
	}
	for k, v := range extra {
		m[k] = v
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func plainUser(id, key, ip string) core.User {
	return core.User{UserID: id, WireguardPublicKey: key, WireguardAllowedIP: ip}
}

// wg-quick aborts the whole interface on the first key it does not know, so a
// plain config carries none of the AmneziaWG lines, not even zeroed ones.
func TestPlainConfigHasNoObfuscationLines(t *testing.T) {
	blob, err := renderConfig(func() InboundConfig { c := plainInbound(); c.Plain = true; return c }(),
		[]Peer{{PublicKey: testWGPubKeyA, AllowedIP: "10.77.77.2/32"}})
	if err != nil {
		t.Fatalf("renderConfig: %v", err)
	}
	for _, key := range []string{"Jc", "Jmin", "Jmax", "S1", "S2", "S3", "S4", "H1", "H2", "H3", "H4", "I1", "I5", "MTU"} {
		if strings.Contains(blob, key+" =") {
			t.Errorf("plain config carries %q:\n%s", key, blob)
		}
	}
	for _, want := range []string{"[Interface]", "PrivateKey = " + testWGPrivKey, "ListenPort = 51820",
		"Address = 10.77.77.1/24", "[Peer]", "PublicKey = " + testWGPubKeyA, "AllowedIPs = 10.77.77.2/32",
		"iptables -t nat -A POSTROUTING -s 10.77.77.0/24 ! -o %i -j MASQUERADE"} {
		if !strings.Contains(blob, want) {
			t.Errorf("plain config misses %q:\n%s", want, blob)
		}
	}
}

// The AmneziaWG render is what it was.
func TestAmneziawgConfigStillRendersItsObfuscation(t *testing.T) {
	blob, err := renderConfig(validInbound(), nil)
	if err != nil {
		t.Fatalf("renderConfig: %v", err)
	}
	for _, want := range []string{"Jc = 4", "S1 = 72", "H1 = 100", "H4 = 400"} {
		if !strings.Contains(blob, want) {
			t.Errorf("amneziawg config misses %q:\n%s", want, blob)
		}
	}
}

// An obfuscation value on a plain interface means a caller crossed the two
// configs; rendering it away would leave an operator believing a tunnel is
// hidden when it is not.
func TestPlainValidateRefusesWhatIsAmneziawgOnly(t *testing.T) {
	cases := map[string]func(*InboundConfig){
		"Jc":       func(c *InboundConfig) { c.Jc = 4 },
		"Jmax":     func(c *InboundConfig) { c.Jmax = 70 },
		"S1":       func(c *InboundConfig) { c.S1 = 72 },
		"H1":       func(c *InboundConfig) { c.H1 = 100 },
		"I1":       func(c *InboundConfig) { c.I1 = "c0ffee" },
		"geometry": func(c *InboundConfig) { c.Geometry = &Geometry3{} },
		"cascade":  func(c *InboundConfig) { c.Chain = &ChainTProxy{Port: 25000, Mark: 0x1ec00} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			cfg := plainInbound()
			cfg.Plain = true
			mutate(&cfg)
			err := cfg.validate()
			if err == nil {
				t.Fatal("accepted")
			}
			if !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(name)) {
				t.Errorf("the error does not name %s: %v", name, err)
			}
		})
	}
	// And the key is still required.
	bare := InboundConfig{Plain: true}
	if err := bare.validate(); err == nil {
		t.Error("a plain interface without a key was accepted")
	}
}

func TestPlainInstanceIdentityAndDefaults(t *testing.T) {
	a := New(Config{Protocol: NameWireguard}, quietLogger())
	if a.Name() != "wireguard" || a.Engine() != "wireguard" {
		t.Errorf("Name/Engine = %q/%q, want wireguard/wireguard", a.Name(), a.Engine())
	}
	if a.cfg.Inbound.Interface != "wg0" || a.cfg.ConfigPath != "/etc/wireguard/wg0.conf" {
		t.Errorf("interface/config = %q/%q", a.cfg.Inbound.Interface, a.cfg.ConfigPath)
	}
	if got := a.statePath(); got != "/etc/wireguard/wg0.state.json" {
		t.Errorf("statePath = %q: it sits beside the config", got)
	}
	if !a.cfg.Inbound.Plain {
		t.Error("the inbound is not stamped plain")
	}
	if a.v3 != nil {
		t.Error("a plain instance carries a 3.1 interface")
	}
	if got := a.unitName("wg0"); got != "wg-quick@wg0" {
		t.Errorf("unit = %q", got)
	}

	awg := New(Config{}, quietLogger())
	if awg.Name() != "amneziawg" || awg.Engine() != "amneziawg" || awg.cfg.Inbound.Plain || awg.v3 == nil {
		t.Errorf("the default instance is not AmneziaWG: %q/%q plain=%v v3=%v",
			awg.Name(), awg.Engine(), awg.cfg.Inbound.Plain, awg.v3 != nil)
	}
	if awg.cfg.ConfigPath != "/etc/amnezia/amneziawg/awg0.conf" || awg.unitName("awg0") != "awg-quick@awg0" {
		t.Errorf("AmneziaWG defaults moved: %q, %q", awg.cfg.ConfigPath, awg.unitName("awg0"))
	}
	// Anything but "wireguard" is the AmneziaWG default, never a third mode.
	if New(Config{Protocol: "other"}, quietLogger()).Name() != "amneziawg" {
		t.Error("an unknown protocol did not fall back to amneziawg")
	}
}

// ApplyInbound as the panel will send it: no obfuscation object at all.
func TestPlainApplyInboundBringsWg0UpWithoutObfuscation(t *testing.T) {
	fake := &fakeCLI{}
	dir := t.TempDir()
	a := newPlainAdapter(t, dir, fake)
	if err := a.ApplyInbound(51899, plainWire(t, nil)); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	blob, err := os.ReadFile(filepath.Join(dir, "wg0.conf"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"ListenPort = 51899", "Address = 10.77.77.1/24"} {
		if !strings.Contains(string(blob), want) {
			t.Errorf("config misses %q:\n%s", want, blob)
		}
	}
	if strings.Contains(string(blob), "H1 =") || strings.Contains(string(blob), "Jc =") {
		t.Errorf("obfuscation on a plain interface:\n%s", blob)
	}
	seq := fake.sequence()
	if len(seq) == 0 || !strings.HasPrefix(seq[len(seq)-1], "wg-quick up wg0") {
		t.Errorf("the interface was not brought up with wg-quick: %v", seq)
	}
	for _, c := range seq {
		if strings.HasPrefix(c, "awg") {
			t.Errorf("an awg tool was called by the plain instance: %s", c)
		}
	}
	// Healthy asks `wg show wg0` through the runner, which answers success.
	if !a.Healthy() {
		t.Error("not healthy after the first push")
	}
}

// An obfuscated push at a plain instance is an error, and writes nothing.
func TestPlainApplyInboundRefusesAnObfuscatedPush(t *testing.T) {
	fake := &fakeCLI{}
	dir := t.TempDir()
	a := newPlainAdapter(t, dir, fake)
	wire := plainWire(t, map[string]any{"obfuscation": map[string]any{
		"jc": 4, "jmin": 40, "jmax": 70, "s1": 72, "s2": 56, "s3": 32, "s4": 16,
		"h1": 100, "h2": 200, "h3": 300, "h4": 400,
	}})
	if err := a.ApplyInbound(51899, wire); err == nil {
		t.Fatal("an obfuscated config was accepted by a plain instance")
	}
	if _, err := os.Stat(filepath.Join(dir, "wg0.conf")); !os.IsNotExist(err) {
		t.Error("the refused config was written")
	}
	for _, c := range fake.sequence() {
		if strings.Contains(c, " up ") {
			t.Errorf("an interface was brought up from a refused push: %s", c)
		}
	}
	// A 3.1 inbound is not this instance's either.
	if err := a.ApplyInbound(51899, plainWire(t, map[string]any{"awgProtocol": 3})); err == nil {
		t.Error("a 3.1 inbound was accepted by a plain instance")
	}
}

// A peer comes and goes through strip + syncconf: the interface is not bounced,
// so the other peers' handshakes stay.
func TestPlainPeersAreAddedAndRemovedWithoutBouncingTheInterface(t *testing.T) {
	fake := &fakeCLI{}
	dir := t.TempDir()
	a := newPlainAdapter(t, dir, fake)
	if err := a.ApplyInbound(51899, plainWire(t, nil)); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	mark := len(fake.sequence())

	if err := a.AddUser(plainUser("alice", testWGPubKeyA, "10.77.77.2")); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(plainUser("bob", testWGPubKeyB, "10.77.77.3")); err != nil {
		t.Fatal(err)
	}
	if err := a.RemoveUser("alice"); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(dir, "wg0.conf")
	blob, _ := os.ReadFile(cfg)
	if strings.Contains(string(blob), testWGPubKeyA) || !strings.Contains(string(blob), testWGPubKeyB) {
		t.Errorf("config after add, add, remove:\n%s", blob)
	}
	seq := fake.sequence()[mark:]
	syncs := 0
	for _, c := range seq {
		switch {
		case strings.HasPrefix(c, "wg-quick strip "+cfg):
		case strings.HasPrefix(c, "wg syncconf wg0 "):
			syncs++
		default:
			t.Errorf("a peer change ran %q: only strip and syncconf may run, the interface is not bounced", c)
		}
	}
	if syncs != 3 {
		t.Errorf("syncconf ran %d times for three peer changes: %v", syncs, seq)
	}
}

// When syncconf fails the fallback bounces the unit of THIS flavour.
func TestPlainSyncconfFailureFallsBackToTheWgQuickUnit(t *testing.T) {
	fake := &fakeCLI{handler: func(name string, args []string) ([]byte, error) {
		if name == "wg" && len(args) > 0 && args[0] == "syncconf" {
			return []byte("boom"), os.ErrInvalid
		}
		return nil, nil
	}}
	a := newPlainAdapter(t, t.TempDir(), fake)
	if err := a.ApplyInbound(51899, plainWire(t, nil)); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(plainUser("alice", testWGPubKeyA, "10.77.77.2")); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if !strings.Contains(strings.Join(fake.sequence(), "\n"), "systemctl restart wg-quick@wg0") {
		t.Errorf("no restart of wg-quick@wg0: %v", fake.sequence())
	}
}

// After an agent restart the peers come back from the state file, and the first
// push over the live interface neither brings it down nor drops them.
func TestPlainPeersSurviveAnAgentRestart(t *testing.T) {
	dir := t.TempDir()
	before := newPlainAdapter(t, dir, &fakeCLI{})
	if err := before.ApplyInbound(51899, plainWire(t, nil)); err != nil {
		t.Fatal(err)
	}
	if err := before.AddUser(plainUser("alice", testWGPubKeyA, "10.77.77.2")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "wg0.state.json")); err != nil {
		t.Fatalf("no state file beside the config: %v", err)
	}

	second := &fakeCLI{}
	after := newPlainAdapter(t, dir, second)
	after.mu.Lock()
	_, known := after.peers["alice"]
	plain := after.cfg.Inbound.Plain
	after.mu.Unlock()
	if !known {
		t.Fatal("the restarted agent does not know alice")
	}
	if !plain {
		t.Fatal("the restored inbound lost its plain stamp")
	}
	if !after.Provisioned() {
		t.Error("restored with a key and Provisioned says no")
	}
	if err := after.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := after.ApplyInbound(51899, plainWire(t, nil)); err != nil {
		t.Fatal(err)
	}
	for _, c := range second.sequence() {
		if strings.HasPrefix(c, "wg-quick down") {
			t.Errorf("the restart took the interface down: %v", second.sequence())
		}
	}
	blob, _ := os.ReadFile(filepath.Join(dir, "wg0.conf"))
	if !strings.Contains(string(blob), testWGPubKeyA) {
		t.Errorf("the config lost the peer:\n%s", blob)
	}
	if err := after.RemoveUser("alice"); err != nil {
		t.Fatal(err)
	}
}

// The two instances share nothing: not peers, not files, not the user's
// credentials. A node bound to both profiles is sent two addresses for one key.
func TestTheTwoInstancesDoNotSeeEachOthersPeers(t *testing.T) {
	dir := t.TempDir()
	plainFake, awgFake := &fakeCLI{}, &fakeCLI{}
	wg := newPlainAdapter(t, dir, plainFake)
	awg := New(Config{
		ConfigPath:   filepath.Join(dir, "awg0.conf"),
		AwgBin:       "awg",
		AwgQuickBin:  "awg-quick",
		SystemctlBin: "systemctl",
		runCmd:       awgFake.run,
	}, quietLogger())
	if err := wg.ApplyInbound(51899, plainWire(t, nil)); err != nil {
		t.Fatal(err)
	}
	if err := awg.ApplyInbound(51820, wireFor(t, validInbound())); err != nil {
		t.Fatal(err)
	}

	both := core.User{
		UserID:             "alice",
		AmneziaWGPublicKey: testWGPubKeyA, AmneziaWGAllowedIP: "10.66.66.7",
		WireguardPublicKey: testWGPubKeyA, WireguardAllowedIP: "10.77.77.9",
	}
	only := core.User{UserID: "bob", WireguardPublicKey: testWGPubKeyB, WireguardAllowedIP: "10.77.77.10"}
	onlyAwg := core.User{UserID: "carol", AmneziaWGPublicKey: testWGPubKeyC, AmneziaWGAllowedIP: "10.66.66.8"}
	for _, u := range []core.User{both, only, onlyAwg} {
		for _, a := range []*Adapter{wg, awg} {
			if err := a.AddUser(u); err != nil {
				t.Fatalf("AddUser %s on %s: %v", u.UserID, a.Name(), err)
			}
		}
	}
	wgBlob, _ := os.ReadFile(filepath.Join(dir, "wg0.conf"))
	awgBlob, _ := os.ReadFile(filepath.Join(dir, "awg0.conf"))

	if !strings.Contains(string(wgBlob), "AllowedIPs = 10.77.77.9/32") || !strings.Contains(string(wgBlob), "AllowedIPs = 10.77.77.10/32") {
		t.Errorf("wg0 misses its peers:\n%s", wgBlob)
	}
	if strings.Contains(string(wgBlob), "10.66.66.") || strings.Contains(string(wgBlob), testWGPubKeyC) {
		t.Errorf("wg0 took what is awg0's:\n%s", wgBlob)
	}
	if !strings.Contains(string(awgBlob), "AllowedIPs = 10.66.66.7/32") || !strings.Contains(string(awgBlob), "AllowedIPs = 10.66.66.8/32") {
		t.Errorf("awg0 misses its peers:\n%s", awgBlob)
	}
	if strings.Contains(string(awgBlob), "10.77.77.") || strings.Contains(string(awgBlob), testWGPubKeyB) {
		t.Errorf("awg0 took what is wg0's:\n%s", awgBlob)
	}
	// The interface names each tool was asked about stay apart too.
	for _, c := range plainFake.sequence() {
		if bin := strings.Fields(c)[0]; strings.HasPrefix(bin, "awg") {
			t.Errorf("the plain instance ran an awg tool: %s", c)
		}
	}
	for _, c := range awgFake.sequence() {
		if bin := strings.Fields(c)[0]; bin == "wg" || bin == "wg-quick" {
			t.Errorf("the AmneziaWG instance ran a plain tool: %s", c)
		}
	}
	// Removal is per instance as well.
	if err := wg.RemoveUser("alice"); err != nil {
		t.Fatal(err)
	}
	awg.mu.Lock()
	_, still := awg.peers["alice"]
	awg.mu.Unlock()
	if !still {
		t.Error("removing alice from wg0 removed her from awg0")
	}
}

// The scoped add (A-022) names the plain instance's own inbound.
func TestPlainAddUserOnIsScopedByItsInbound(t *testing.T) {
	a := newPlainAdapter(t, t.TempDir(), &fakeCLI{})
	if err := a.ApplyInbound(51899, plainWire(t, map[string]any{"inboundId": "ib-wg"})); err != nil {
		t.Fatal(err)
	}
	u := plainUser("alice", testWGPubKeyA, "10.77.77.2")
	if err := a.AddUserOn(u, []string{"ib-wg"}); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	_, on := a.peers["alice"]
	a.mu.Unlock()
	if !on {
		t.Fatal("not added on its own inbound")
	}
	if err := a.AddUserOn(u, []string{"ib-other"}); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	_, on = a.peers["alice"]
	a.mu.Unlock()
	if on {
		t.Error("still on the interface after the panel named another inbound")
	}
}

// Plain WireGuard is no chain entry: a hand-off is refused and the nil the
// server sends every receiver is a no-op that leaves the interface alone.
func TestPlainIsNotACascadeEntry(t *testing.T) {
	fake := &fakeCLI{}
	a := newPlainAdapter(t, t.TempDir(), fake)
	if err := a.ApplyInbound(51899, plainWire(t, nil)); err != nil {
		t.Fatal(err)
	}
	mark := len(fake.sequence())
	for _, raw := range []string{"", "null"} {
		if err := a.ApplyCascade(json.RawMessage(raw)); err != nil {
			t.Errorf("ApplyCascade(%q): %v", raw, err)
		}
	}
	if err := a.ApplyCascade(json.RawMessage(`{"port":25000,"mark":117356}`)); err == nil {
		t.Error("a hand-off was accepted by plain WireGuard")
	}
	if a.cfg.Inbound.Chain != nil {
		t.Error("a hand-off was remembered")
	}
	if n := len(fake.sequence()); n != mark {
		t.Errorf("the cascade calls ran commands: %v", fake.sequence()[mark:])
	}
}

// The version comes from `wg --version`, in both fields, and an agent that is
// not AmneziaWG reports no protocol generation.
func TestPlainReportsWgVersionAndNoAwgGeneration(t *testing.T) {
	a := New(Config{
		Protocol:    NameWireguard,
		AwgBin:      fakeBinary(t, "wg"),
		AwgQuickBin: "wg-quick",
		ConfigPath:  t.TempDir() + "/wg0.conf",
		runCmd: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) == 1 && args[0] == "--version" {
				return []byte("wireguard-tools v1.0.20210914 - https://git.zx2c4.com/wireguard-tools/\n"), nil
			}
			return nil, nil
		},
	}, quietLogger())
	if got := a.CoreVersion(); got != "1.0.20210914" {
		t.Errorf("CoreVersion = %q", got)
	}
	if got := a.ToolsVersion(); got != "1.0.20210914" {
		t.Errorf("ToolsVersion = %q", got)
	}
	if a.AwgProtocol() != 0 || a.AwgGenerations() != nil {
		t.Errorf("a plain instance reports AmneziaWG generations: %d, %v", a.AwgProtocol(), a.AwgGenerations())
	}
}
