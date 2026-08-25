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

func plainInbound() InboundConfig {
	return InboundConfig{
		PrivateKey: testWGPrivKey,
		Address:    "10.77.77.1/24",
		Plain:      true,
	}
}

// A vanilla wg-quick aborts the whole interface bring-up on the first key it
// doesn't recognise, so the plain renderer must emit none of the AmneziaWG
// directives, not even zeroed ones.
func TestRenderConfig_PlainOmitsObfuscation(t *testing.T) {
	blob, err := renderConfig(plainInbound(), []Peer{
		{PublicKey: testWGPubKeyA, AllowedIP: "10.77.77.2/32"},
	})
	if err != nil {
		t.Fatalf("renderConfig: %v", err)
	}
	for _, key := range []string{"Jc", "Jmin", "Jmax", "S1", "S2", "S3", "S4", "H1", "H2", "H3", "H4", "I1"} {
		if strings.Contains(blob, key+" =") {
			t.Errorf("plain config carries AmneziaWG key %q:\n%s", key, blob)
		}
	}
	for _, want := range []string{"[Interface]", "PrivateKey = " + testWGPrivKey, "Address = 10.77.77.1/24", "[Peer]", "AllowedIPs = 10.77.77.2/32"} {
		if !strings.Contains(blob, want) {
			t.Errorf("plain config missing %q:\n%s", want, blob)
		}
	}
}

// The AmneziaWG path must be untouched by the split: H1-H4 still render and
// are still refused when they collide with WireGuard's 1..4 markers.
func TestRenderConfig_AmneziawgUnchanged(t *testing.T) {
	blob, err := renderConfig(validInbound(), nil)
	if err != nil {
		t.Fatalf("renderConfig: %v", err)
	}
	for _, want := range []string{"Jc = 4", "S1 = 72", "H1 = 100", "H4 = 400"} {
		if !strings.Contains(blob, want) {
			t.Errorf("amneziawg config missing %q:\n%s", want, blob)
		}
	}

	collide := validInbound()
	collide.H1 = 1
	if _, err := renderConfig(collide, nil); err == nil {
		t.Error("expected H1=1 to be rejected on an amneziawg interface")
	}
}

// An obfuscation value on a plain interface means a caller crossed the two
// configs. Rendering it away silently would leave the operator believing the
// interface is obfuscated when it isn't, so it's an error.
func TestValidate_PlainRejectsObfuscation(t *testing.T) {
	cases := map[string]func(*InboundConfig){
		"Jc": func(c *InboundConfig) { c.Jc = 4 },
		"S1": func(c *InboundConfig) { c.S1 = 72 },
		"H1": func(c *InboundConfig) { c.H1 = 100 },
		"I1": func(c *InboundConfig) { c.I1 = "c0ffee" },
	}
	for name, mutate := range cases {
		cfg := plainInbound()
		mutate(&cfg)
		err := cfg.validate()
		if err == nil {
			t.Errorf("%s: expected plain validate to reject the value", name)
			continue
		}
		if !strings.Contains(err.Error(), name) {
			t.Errorf("%s: error should name the field, got %v", name, err)
		}
	}
}

func TestNew_WireguardDefaults(t *testing.T) {
	a := New(Config{Protocol: NameWireguard}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if got := a.Name(); got != "wireguard" {
		t.Errorf("Name: got %q", got)
	}
	if got := a.Engine(); got != "wireguard" {
		t.Errorf("Engine: got %q", got)
	}
	if got := a.cfg.Inbound.Interface; got != "wg0" {
		t.Errorf("Interface default: got %q", got)
	}
	if got := a.cfg.ConfigPath; got != "/etc/wireguard/wg0.conf" {
		t.Errorf("ConfigPath default: got %q", got)
	}
	if !a.cfg.Inbound.Plain {
		t.Error("wireguard adapter should render in plain mode")
	}
	if got := a.unitName("wg0"); got != "wg-quick@wg0" {
		t.Errorf("unitName: got %q", got)
	}

	awg := New(Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if got := awg.Name(); got != "amneziawg" {
		t.Errorf("default protocol: got %q", got)
	}
	if got := awg.cfg.ConfigPath; got != "/etc/amnezia/amneziawg/awg0.conf" {
		t.Errorf("amneziawg ConfigPath default: got %q", got)
	}
	if got := awg.unitName("awg0"); got != "awg-quick@awg0" {
		t.Errorf("amneziawg unitName: got %q", got)
	}
	if awg.cfg.Inbound.Plain {
		t.Error("amneziawg adapter must not render in plain mode")
	}
}

// A node bound to both profiles gets two IPs for the same user, one per
// subnet. Each adapter must take its own and ignore the other's, otherwise
// peers land on the wrong interface with an IP outside its subnet.
func TestAddUser_PicksCredentialsPerFlavour(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	dir := t.TempDir()

	wg := New(Config{
		Protocol:   NameWireguard,
		ConfigPath: filepath.Join(dir, "wg0.conf"),
		Inbound:    plainInbound(),
	}, logger)
	awg := New(Config{
		ConfigPath: filepath.Join(dir, "awg0.conf"),
		Inbound:    validInbound(),
	}, logger)

	user := core.User{
		UserID:             "u-alice",
		AmneziaWGPublicKey: testWGPubKeyA,
		AmneziaWGAllowedIP: "10.66.66.7",
		WireguardPublicKey: testWGPubKeyA,
		WireguardAllowedIP: "10.77.77.9",
	}
	for _, a := range []*Adapter{wg, awg} {
		if err := a.Start(context.Background()); err != nil {
			t.Fatalf("Start %s: %v", a.Name(), err)
		}
		if err := a.AddUser(user); err != nil {
			t.Fatalf("AddUser %s: %v", a.Name(), err)
		}
	}

	wgBlob := readFile(t, filepath.Join(dir, "wg0.conf"))
	if !strings.Contains(wgBlob, "AllowedIPs = 10.77.77.9/32") {
		t.Errorf("wireguard peer took the wrong IP:\n%s", wgBlob)
	}
	if strings.Contains(wgBlob, "10.66.66.7") {
		t.Errorf("wireguard peer took the amneziawg IP:\n%s", wgBlob)
	}
	awgBlob := readFile(t, filepath.Join(dir, "awg0.conf"))
	if !strings.Contains(awgBlob, "AllowedIPs = 10.66.66.7/32") {
		t.Errorf("amneziawg peer took the wrong IP:\n%s", awgBlob)
	}

	// A user with only AWG creds is a no-op for the plain interface.
	if err := wg.AddUser(core.User{UserID: "u-bob", AmneziaWGPublicKey: testWGPubKeyB, AmneziaWGAllowedIP: "10.66.66.8"}); err != nil {
		t.Fatalf("AddUser awg-only: %v", err)
	}
	if n := len(wg.peers); n != 1 {
		t.Errorf("expected the awg-only user to be skipped, got %d peers", n)
	}
}

// The panel pushes a wireguard inbound with no obfuscation object at all; the
// zero-valued struct that produces must survive the plain validator.
func TestApplyInbound_PlainWire(t *testing.T) {
	dir := t.TempDir()
	a := New(Config{
		Protocol:   NameWireguard,
		ConfigPath: filepath.Join(dir, "wg0.conf"),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	raw, err := json.Marshal(map[string]any{
		"subnet":           "10.77.77.0/24",
		"serverPrivateKey": testWGPrivKey,
		"serverPublicKey":  testWGPubKeyC,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := a.ApplyInbound(51899, raw); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}

	blob := readFile(t, filepath.Join(dir, "wg0.conf"))
	if !strings.Contains(blob, "ListenPort = 51899") {
		t.Errorf("pushed port not applied:\n%s", blob)
	}
	if !strings.Contains(blob, "Address = 10.77.77.1/24") {
		t.Errorf("server address not derived from subnet:\n%s", blob)
	}
	if strings.Contains(blob, "H1 =") {
		t.Errorf("plain interface rendered magic headers:\n%s", blob)
	}
}

// An amneziawg config pushed at a plain adapter must fail loudly rather than
// come up as an unobfuscated interface the operator didn't ask for.
func TestApplyInbound_PlainRejectsObfuscatedWire(t *testing.T) {
	dir := t.TempDir()
	a := New(Config{
		Protocol:   NameWireguard,
		ConfigPath: filepath.Join(dir, "wg0.conf"),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	raw, err := json.Marshal(map[string]any{
		"subnet":           "10.77.77.0/24",
		"serverPrivateKey": testWGPrivKey,
		"serverPublicKey":  testWGPubKeyC,
		"obfuscation": map[string]any{
			"jc": 4, "jmin": 64, "jmax": 128,
			"s1": 32, "s2": 56, "s3": 32, "s4": 16,
			"h1": 100, "h2": 200, "h3": 300, "h4": 400,
		},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := a.ApplyInbound(51899, raw); err == nil {
		t.Fatal("expected an obfuscated config to be rejected on a plain adapter")
	}
	if _, err := os.Stat(filepath.Join(dir, "wg0.conf")); !os.IsNotExist(err) {
		t.Error("rejected config must not be written to disk")
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	blob, err := io.ReadAll(f)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(blob)
}
