package core

import (
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

func TestRestartTallyCountsByCause(t *testing.T) {
	tally := NewRestartTally()
	at := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	tally.Record(subprocess.RestartEvent{Reason: subprocess.RestartReasonMemory, At: at})
	tally.Record(subprocess.RestartEvent{Reason: subprocess.RestartReasonCrash, At: at.Add(time.Minute)})
	tally.Record(subprocess.RestartEvent{Reason: subprocess.RestartReasonCrash, At: at.Add(2 * time.Minute)})
	st := tally.Stats(0, 42)
	if st.Crash != 2 || st.Memory != 1 {
		t.Fatalf("crash=%d memory=%d, want 2 and 1", st.Crash, st.Memory)
	}
	if !st.LastAt.Equal(at.Add(2*time.Minute)) || st.LastReason != string(subprocess.RestartReasonCrash) {
		t.Fatalf("last = %v %q", st.LastAt, st.LastReason)
	}
	if st.SinceAt.IsZero() || st.RSSBytes != 42 {
		t.Fatalf("since=%v rss=%d", st.SinceAt, st.RSSBytes)
	}
	var none *RestartTally
	none.Record(subprocess.RestartEvent{})
	if got := none.Stats(0, 0); got.Crash != 0 {
		t.Fatal("a nil tally counted")
	}
}
