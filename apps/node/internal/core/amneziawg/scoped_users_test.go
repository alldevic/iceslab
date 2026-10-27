package amneziawg

import (
	"os"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A-022: a user scoped to the 3.1 inbound is a peer of awg3 and not of awg0,
// and the other way round, one interface per generation.
func TestAUserScopedToOneGenerationIsOnItsInterfaceOnly(t *testing.T) {
	a, _ := twoInterfaceAdapter(t)
	if err := a.ApplyInbound(51820, inboundJSON(t, "b1", 1, nil)); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(51830, inboundJSON(t, "b3", 3, fixtureWire(t))); err != nil {
		t.Fatal(err)
	}
	u := core.User{UserID: "alice", AmneziaWGPublicKey: testPeerKey,
		AmneziaWGAllowedIP: "10.66.66.2", AmneziaWGAllowedIP3: "10.67.67.2"}

	peerOn := func(path string) bool {
		blob, _ := os.ReadFile(path)
		return strings.Contains(string(blob), testPeerKey)
	}

	if err := a.AddUserOn(u, []string{"b3"}); err != nil {
		t.Fatalf("AddUserOn b3: %v", err)
	}
	if peerOn(a.cfg.ConfigPath) || !peerOn(a.v3.cfg.ConfigPath) {
		t.Fatalf("scoped to 3.1: awg0=%v awg3=%v, want awg3 only", peerOn(a.cfg.ConfigPath), peerOn(a.v3.cfg.ConfigPath))
	}

	if err := a.AddUserOn(u, []string{"b1"}); err != nil {
		t.Fatalf("AddUserOn b1: %v", err)
	}
	if !peerOn(a.cfg.ConfigPath) || peerOn(a.v3.cfg.ConfigPath) {
		t.Fatalf("scoped to 1.x: awg0=%v awg3=%v, want awg0 only", peerOn(a.cfg.ConfigPath), peerOn(a.v3.cfg.ConfigPath))
	}
}
