package server

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// restartingCore additionally reports a restart tally (core.RestartReporter).
type restartingCore struct {
	fakeCore
	stats core.RestartStats
}

func (r *restartingCore) RestartStats() core.RestartStats { return r.stats }

// restartsOf is the `restarts` object of the named core on the wire, or nil
// when the key is absent.
func restartsOf(t *testing.T, name string, adapters ...core.CoreAdapter) map[string]any {
	t.Helper()
	var body struct {
		Cores []map[string]any `json:"cores"`
	}
	if err := json.Unmarshal([]byte(healthBody(t, adapters...)), &body); err != nil {
		t.Fatalf("decode /healthz: %v", err)
	}
	for _, c := range body.Cores {
		if c["name"] == name {
			r, _ := c["restarts"].(map[string]any)
			return r
		}
	}
	t.Fatalf("core %q missing from /healthz", name)
	return nil
}

func TestHealthReportsTheRestartsOfACoreThatCountsThem(t *testing.T) {
	since := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	last := time.Date(2026, 8, 26, 4, 30, 0, 0, time.UTC)
	rc := &restartingCore{
		fakeCore: fakeCore{name: "hysteria", running: true},
		stats: core.RestartStats{
			Crash: 2, Memory: 3,
			LastAt: last, LastReason: "memory", SinceAt: since,
			MemoryLimitBytes: 512 << 20, RSSBytes: 400 << 20,
		},
	}
	got := restartsOf(t, "hysteria", rc)
	if got == nil {
		t.Fatal("restarts missing for a core that implements core.RestartReporter")
	}
	if got["total"] != float64(5) || got["crash"] != float64(2) || got["memory"] != float64(3) {
		t.Errorf("restarts = %v, want total 5 = crash 2 + memory 3", got)
	}
	if got["core"] != "hysteria" || got["lastReason"] != "memory" {
		t.Errorf("restarts = %v, want the core's name and the last reason", got)
	}
	if got["lastAt"] != "2026-08-26T04:30:00Z" || got["sinceAt"] != "2026-08-01T10:00:00Z" {
		t.Errorf("restarts = %v, want RFC3339 UTC lastAt and sinceAt", got)
	}
	if got["memoryLimitBytes"] != float64(512<<20) || got["rssBytes"] != float64(400<<20) {
		t.Errorf("restarts = %v, want the ceiling and the latest sample", got)
	}
}

// Absent is "this core does not report", not "zero restarts": a panel that read
// it as zero would overwrite a tally it already holds.
func TestHealthSendsNoRestartsForACoreWithoutATally(t *testing.T) {
	if got := restartsOf(t, "hysteria", &fakeCore{name: "hysteria", running: true}); got != nil {
		t.Errorf("restarts = %v for a core that does not implement core.RestartReporter", got)
	}
}

// A zero time formatted as RFC3339 reads as "restarted in year 1".
func TestHealthOmitsRestartTimestampsThatNeverHappened(t *testing.T) {
	got := restartsOf(t, "hysteria", &restartingCore{fakeCore: fakeCore{name: "hysteria", running: true}})
	if got == nil {
		t.Fatal("restarts missing for a core that implements core.RestartReporter")
	}
	for _, key := range []string{"lastAt", "sinceAt"} {
		if v, present := got[key]; present {
			t.Errorf("%s = %v on a tally that never set it", key, v)
		}
	}
}
