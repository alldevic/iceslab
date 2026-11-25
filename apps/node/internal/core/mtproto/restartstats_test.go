package mtproto

import (
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

// The adapter reports its restarts through core.RestartReporter: the
// supervisor restarts the core and OnRestart feeds the tally, so a restart that
// succeeds still leaves a trace on /healthz.
var _ core.RestartReporter = (*Adapter)(nil)

func TestRestartStats_TellsCrashFromMemory(t *testing.T) {
	a := newConfigOnlyAdapter(t)

	st := a.RestartStats()
	if st.Crash != 0 || st.Memory != 0 {
		t.Fatalf("a fresh adapter already counts restarts: %+v", st)
	}
	if st.SinceAt.IsZero() {
		t.Error("SinceAt is zero, so a count on the card has no start to read against")
	}

	at := time.Date(2026, 8, 27, 6, 0, 0, 0, time.UTC)
	a.restarts.Record(subprocess.RestartEvent{Reason: subprocess.RestartReasonCrash, At: at})
	a.restarts.Record(subprocess.RestartEvent{Reason: subprocess.RestartReasonMemory, At: at.Add(time.Minute)})

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

// No memory watchdog is armed for this adapter, so the ceiling it reports is 0.
func TestRestartStats_ReportsNoCeilingItDoesNotArm(t *testing.T) {
	if got := newConfigOnlyAdapter(t).RestartStats().MemoryLimitBytes; got != 0 {
		t.Errorf("MemoryLimitBytes = %d for an adapter with no watchdog", got)
	}
}
