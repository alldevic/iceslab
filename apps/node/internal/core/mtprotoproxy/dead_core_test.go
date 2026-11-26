package mtprotoproxy

import (
	"context"
	"testing"
)

// A core that died after it had passed the startup window is not "unchanged":
// the same push starts it again.
func TestApplyInbound_UnchangedPushWithACoreThatDiedLateStartsItAgain(t *testing.T) {
	f := processFixture(t, true)
	a := f.a
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, f.starts, "run"); n != 1 {
		t.Fatalf("the first push ran the core %d times, want 1", n)
	}

	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if err := proc.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	failed := a.lastStartFailed
	a.mu.Unlock()
	if failed || a.Healthy() {
		t.Fatalf("setup: lastStartFailed=%v healthy=%v, want the late death", failed, a.Healthy())
	}

	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, f.starts, "run"); n != 2 {
		t.Fatalf("an unchanged push left the dead core dead: %d runs, want 2", n)
	}
	if !a.Healthy() {
		t.Error("the restarted core does not report healthy")
	}
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, f.starts, "run"); n != 2 {
		t.Errorf("an unchanged push with a live core restarted it: %d runs", n)
	}
}
