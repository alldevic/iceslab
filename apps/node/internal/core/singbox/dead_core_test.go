package singbox

import (
	"context"
	"os"
	"testing"
)

// A core that died after it had passed the startup window is not "unchanged":
// the same push starts it again.
func TestApplyInbound_UnchangedPushWithACoreThatDiedLateStartsItAgain(t *testing.T) {
	a, _, marker, starts := startupFixture(t)
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	wire := []byte(startupWire)
	if err := a.ApplyInbound(9443, wire); err != nil {
		t.Fatal(err)
	}
	before := startCount(starts)

	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if err := proc.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	failed := a.lastStartFailed
	a.mu.Unlock()
	if failed {
		t.Fatal("setup: lastStartFailed is set, the case is not the late death")
	}

	if err := a.ApplyInbound(9443, wire); err != nil {
		t.Fatal(err)
	}
	if n := startCount(starts); n != before+1 {
		t.Fatalf("an unchanged push left the dead core dead: %d runs, want %d", n, before+1)
	}
	if err := a.ApplyInbound(9443, wire); err != nil {
		t.Fatal(err)
	}
	if n := startCount(starts); n != before+1 {
		t.Errorf("an unchanged push with a live core restarted it: %d runs", n)
	}
}
