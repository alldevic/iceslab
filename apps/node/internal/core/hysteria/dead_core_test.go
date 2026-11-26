package hysteria

import (
	"context"
	"os"
	"testing"
)

// A core that died after it had passed the startup window is not "unchanged":
// the same push spawns it again (spawn mode; under systemd the unit is
// systemd's to restart).
func TestApplyInbound_UnchangedPushWithACoreThatDiedLateSpawnsItAgain(t *testing.T) {
	a, _, marker, starts := spawnFixture(t)
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(443, []byte(startupWire)); err != nil {
		t.Fatal(err)
	}
	before := runs(t, starts)

	a.mu.RLock()
	proc := a.proc
	a.mu.RUnlock()
	if err := proc.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.mu.RLock()
	failed := a.lastStartFailed
	a.mu.RUnlock()
	if failed || a.Healthy() {
		t.Fatalf("setup: lastStartFailed=%v healthy=%v, want the late death", failed, a.Healthy())
	}

	if err := a.ApplyInbound(443, []byte(startupWire)); err != nil {
		t.Fatal(err)
	}
	if n := runs(t, starts); n != before+1 {
		t.Fatalf("an unchanged push left the dead core dead: %d runs, want %d", n, before+1)
	}
	if !a.Healthy() {
		t.Error("the respawned core does not report healthy")
	}
	if err := a.ApplyInbound(443, []byte(startupWire)); err != nil {
		t.Fatal(err)
	}
	if n := runs(t, starts); n != before+1 {
		t.Errorf("an unchanged push with a live core spawned again: %d runs", n)
	}
}
