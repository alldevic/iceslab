package xray

import (
	"context"
	"strings"
	"testing"
)

// LastFailure is the whole reason the panel can say WHY a core is down instead
// of only "not running: xray". The plumbing is three lines and none of them
// ever ran: `go test -coverpkg` reported 0.0% for this function, so a version
// that returned "" forever — or that read a process it had already dropped —
// would ship, and the symptom is a node card that says nothing, which is also
// what a healthy quiet node looks like.

// The everyday case this exists for: xray dies on spawn because its port is
// taken, and the operator needs the port back out of it.
func TestLastFailure_CarriesWhatTheCorePrintedOnItsWayOut(t *testing.T) {
	a, _ := newAdapterWithBinary(t, writeTwoFacedXray(t,
		"echo 'listen tcp 0.0.0.0:8443: bind: address already in use' >&2; exit 23"))

	if err := a.regenerateAndRestart(context.Background()); err == nil {
		t.Fatal("fixture problem: the fake core was reported as a successful start")
	}

	got := a.LastFailure()
	if !strings.Contains(got, "address already in use") {
		t.Errorf("LastFailure() = %q; the panel would show a node that is down for no stated reason", got)
	}
}

// The control, and it is not decoration: without it the case above passes
// against an implementation that returns some constant, and against one that
// reports a stale failure from a core that has since come up.
func TestLastFailure_EmptyWhenNothingHasFailed(t *testing.T) {
	a, _ := newAdapterWithBinary(t, writeTwoFacedXray(t, "exec sleep 30"))

	// Before any core exists at all.
	if got := a.LastFailure(); got != "" {
		t.Errorf("LastFailure() = %q on an adapter that never started a core", got)
	}

	if err := a.regenerateAndRestart(context.Background()); err != nil {
		t.Fatalf("fixture problem: a core that stayed up was reported as failed: %v", err)
	}
	if got := a.LastFailure(); got != "" {
		t.Errorf("LastFailure() = %q for a core that is running fine", got)
	}
	_ = a.Stop(context.Background())

	// And after Stop drops the process: the adapter must not keep answering
	// from a core it no longer owns.
	if got := a.LastFailure(); got != "" {
		t.Errorf("LastFailure() = %q after Stop", got)
	}
}
