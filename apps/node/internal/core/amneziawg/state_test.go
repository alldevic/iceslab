package amneziawg

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A real-looking peer key: 44 base64 chars, 32 bytes.
const testPeerKey = "Q2xpZW50UHViS2V5MDAwMDAwMDAwMDAwMDAwMDAwMDA="

// installedAdapter is what main.go builds on a node installed from the panel:
// the interface name and the CLIs, nothing else until the first push.
func installedAdapter(t *testing.T, cfgPath string, fake *fakeCLI) *Adapter {
	t.Helper()
	return New(Config{
		Inbound:      InboundConfig{Interface: "awg0"},
		ConfigPath:   cfgPath,
		AwgBin:       "awg",
		AwgQuickBin:  "awg-quick",
		SystemctlBin: "systemctl",
		SyncTimeout:  500 * time.Millisecond,
		runCmd:       fake.run,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

// A-114, 22.10: the agent restarted over a live interface, its first push
// read the known address "" as a subnet change, and the interface went down
// and came back with no peers.
func TestAnAgentRestartKeepsTheLiveInterfaceAndItsPeers(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "awg0.conf")

	first := &fakeCLI{}
	before := installedAdapter(t, cfgPath, first)
	if err := before.ApplyInbound(51820, wireFor(t, validInbound())); err != nil {
		t.Fatalf("first ApplyInbound: %v", err)
	}
	if err := before.AddUser(core.User{UserID: "alice", AmneziaWGPublicKey: testPeerKey, AmneziaWGAllowedIP: "10.66.66.2"}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}

	// The agent restarts. The kernel kept awg0 up with alice on it.
	second := &fakeCLI{}
	after := installedAdapter(t, cfgPath, second)
	if err := after.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := after.ApplyInbound(51820, wireFor(t, validInbound())); err != nil {
		t.Fatalf("ApplyInbound after restart: %v", err)
	}
	for _, c := range second.sequence() {
		if strings.HasPrefix(c, "awg-quick down") {
			t.Fatalf("the restart took the live interface down: %v", second.sequence())
		}
	}
	after.mu.Lock()
	_, restored := after.peers["alice"]
	after.mu.Unlock()
	if !restored {
		t.Fatal("the new agent does not know the peer the interface carries")
	}
	blob, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(blob), testPeerKey) {
		t.Fatalf("the config after the restart lost the peer:\n%s", blob)
	}

	// And a peer is still removable by its user id after the restart.
	if err := after.RemoveUser("alice"); err != nil {
		t.Fatalf("RemoveUser: %v", err)
	}
	blob, _ = os.ReadFile(cfgPath)
	if strings.Contains(string(blob), testPeerKey) {
		t.Fatal("a peer restored from the previous agent could not be removed")
	}
}

// An idled interface stays idle across a restart: the state is saved without
// the server key, and Start defers as on a fresh node.
func TestAnIdledInterfaceDoesNotComeBackOnRestart(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "awg0.conf")
	before := installedAdapter(t, cfgPath, &fakeCLI{})
	if err := before.ApplyInbound(51820, wireFor(t, validInbound())); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if err := before.Idle(context.Background()); err != nil {
		t.Fatalf("Idle: %v", err)
	}
	after := installedAdapter(t, cfgPath, &fakeCLI{})
	if after.Provisioned() {
		t.Fatal("an interface the last push took down comes back provisioned after a restart")
	}
}

// П-3, 22.10: a peer the render refuses was kept, and every later render of
// the interface failed on it. Now only its own call fails.
func TestABrokenPeerFailsItsOwnCallOnly(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "awg0.conf")
	fake := &fakeCLI{}
	a := installedAdapter(t, cfgPath, fake)
	if err := a.ApplyInbound(51820, wireFor(t, validInbound())); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}

	err := a.AddUser(core.User{UserID: "mallory", AmneziaWGPublicKey: "not-a-key", AmneziaWGAllowedIP: "10.66.66.9"})
	if err == nil {
		t.Fatal("a broken key was accepted")
	}
	a.mu.Lock()
	_, kept := a.peers["mallory"]
	a.mu.Unlock()
	if kept {
		t.Fatal("the broken peer was kept in memory")
	}

	if err := a.AddUser(core.User{UserID: "alice", AmneziaWGPublicKey: testPeerKey, AmneziaWGAllowedIP: "10.66.66.2"}); err != nil {
		t.Fatalf("the next user could not be added after a broken one: %v", err)
	}
	blob, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(blob), testPeerKey) {
		t.Fatalf("the next user did not reach the config:\n%s", blob)
	}
}

// A state file edited by hand cannot put into the config what the panel could
// not: a peer that fails the check is dropped on load.
func TestASavedPeerThatFailsTheCheckIsNotRestored(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "awg0.conf")
	state := `{"inbound":{"Interface":"awg0"},"peers":{
		"alice":{"PublicKey":"` + testPeerKey + `","AllowedIP":"10.66.66.2/32"},
		"evil":{"PublicKey":"x\nPostUp = sh","AllowedIP":"10.66.66.3/32"}}}`
	if err := os.WriteFile(strings.TrimSuffix(cfgPath, ".conf")+".state.json", []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	a := installedAdapter(t, cfgPath, &fakeCLI{})
	a.mu.Lock()
	_, alice := a.peers["alice"]
	_, evil := a.peers["evil"]
	a.mu.Unlock()
	if !alice || evil {
		t.Fatalf("restored alice=%v evil=%v, want alice only", alice, evil)
	}
}
