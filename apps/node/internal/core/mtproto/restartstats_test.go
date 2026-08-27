package mtproto

import (
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

// The tally the panel alerts on.
//
// nodes.cron.ts raises "Core restarted" on GROWTH of this counter, and only on
// growth: a smaller total means the AGENT restarted and lost its in-memory
// count, which is not a core restart. So the two causes have to be told apart
// and the stamp has to move, or the alert either never fires or fires for the
// wrong reason.
//
// Per adapter rather than once: the wiring that feeds this — OnRestart on the
// subprocess.Config — is what five of six adapters did not have, and a tally
// nobody feeds sits at zero forever, which is indistinguishable from a core
// that has not crashed.

func TestRestartStats_TellsCrashFromMemory(t *testing.T) {
	a := lastFailureAdapter(t)

	st := a.RestartStats()
	if st.Crash != 0 || st.Memory != 0 {
		t.Fatalf("a fresh adapter already counts restarts: %+v", st)
	}
	if st.SinceAt.IsZero() {
		t.Error("SinceAt is zero, so '3 restarts' on the card could mean this morning or last June")
	}

	at := time.Date(2026, 8, 27, 6, 0, 0, 0, time.UTC)
	a.recordRestart(subprocess.RestartEvent{Reason: subprocess.RestartReasonCrash, At: at})
	a.recordRestart(subprocess.RestartEvent{Reason: subprocess.RestartReasonMemory, At: at.Add(time.Minute)})

	st = a.RestartStats()
	if st.Crash != 1 || st.Memory != 1 {
		t.Errorf("crash/memory split: got crash=%d memory=%d, want 1/1", st.Crash, st.Memory)
	}
	if !st.LastAt.Equal(at.Add(time.Minute)) {
		t.Errorf("LastAt = %v, want the most recent event", st.LastAt)
	}
	if st.LastReason != string(subprocess.RestartReasonMemory) {
		t.Errorf("LastReason = %q, want %q", st.LastReason, subprocess.RestartReasonMemory)
	}
}

// This adapter arms no memory watchdog, so the ceiling it reports must be 0 —
// the honest report of a watchdog that is off. A non-zero one would put a line
// on the node card that nothing enforces.
func TestRestartStats_ReportsNoCeilingItDoesNotArm(t *testing.T) {
	if got := lastFailureAdapter(t).RestartStats().MemoryLimitBytes; got != 0 {
		t.Errorf("MemoryLimitBytes = %d for an adapter with no watchdog", got)
	}
}
