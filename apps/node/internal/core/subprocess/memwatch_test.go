package subprocess

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// Stands in for "this platform can't read RSS" (the non-Linux build's error).
var errRSSUnreadableForTest = errors.New("test: RSS unreadable")

// Memory-watchdog tests (2026-08-04). RSS is injected via Config.ReadRSS, so
// none of these need a process that actually eats memory - they drive the
// decision logic directly. Like the rest of this package they assume a unix
// box with /bin/sleep.

// shrinkMemoryWindows makes the production thresholds test-sized and restores
// them afterwards.
func shrinkMemoryWindows(t *testing.T, breaches int, minUptime time.Duration) {
	t.Helper()
	oldBreaches, oldUptime := memoryBreachesToRestart, memoryMinUptime
	memoryBreachesToRestart, memoryMinUptime = breaches, minUptime
	t.Cleanup(func() {
		memoryBreachesToRestart, memoryMinUptime = oldBreaches, oldUptime
	})
}

// restartRecorder collects OnRestart events, which is what the adapter (and
// through it the panel) actually consumes.
type restartRecorder struct {
	mu     sync.Mutex
	events []RestartEvent
}

func (r *restartRecorder) record(ev RestartEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, ev)
}

func (r *restartRecorder) snapshot() []RestartEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]RestartEvent(nil), r.events...)
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cond()
}

// TestMemoryWatchdogRestartsOverCeiling: RSS parked above the ceiling for
// enough consecutive samples restarts the core, and the event is labelled
// "memory" (not "crash") with the numbers that caused it.
func TestMemoryWatchdogRestartsOverCeiling(t *testing.T) {
	shrinkMemoryWindows(t, 2, 0)
	rec := &restartRecorder{}
	proc := New(Config{
		Name:                "mem-hog",
		Binary:              "/bin/sleep",
		Args:                []string{"30"},
		Logger:              newSilentLogger(),
		MaxRestarts:         3,
		RestartBackoff:      10 * time.Millisecond,
		MemoryLimitBytes:    1000,
		MemoryCheckInterval: 20 * time.Millisecond,
		ReadRSS:             func(int) (uint64, error) { return 5000, nil },
		OnRestart:           rec.record,
	})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = proc.Stop(context.Background()) }()

	if !waitFor(t, 3*time.Second, func() bool { return len(rec.snapshot()) > 0 }) {
		t.Fatal("no restart within 3s while RSS sat above the ceiling")
	}
	ev := rec.snapshot()[0]
	if ev.Reason != RestartReasonMemory {
		t.Errorf("Reason: got %q, want %q", ev.Reason, RestartReasonMemory)
	}
	if ev.RSSBytes != 5000 || ev.LimitBytes != 1000 {
		t.Errorf("event carried rss=%d limit=%d, want 5000/1000", ev.RSSBytes, ev.LimitBytes)
	}
	// And the core must come back up, not be left down.
	if !waitFor(t, 3*time.Second, proc.Running) {
		t.Error("core did not come back after the memory restart")
	}
}

// TestMemoryWatchdogIgnoresSpike: a single over-limit sample followed by a
// normal one must NOT restart. The whole point of requiring consecutive
// breaches is that a momentary spike doesn't cost every user their connection.
func TestMemoryWatchdogIgnoresSpike(t *testing.T) {
	shrinkMemoryWindows(t, 2, 0)
	rec := &restartRecorder{}
	var calls int
	var mu sync.Mutex
	proc := New(Config{
		Name:                "mem-spike",
		Binary:              "/bin/sleep",
		Args:                []string{"30"},
		Logger:              newSilentLogger(),
		MaxRestarts:         3,
		RestartBackoff:      10 * time.Millisecond,
		MemoryLimitBytes:    1000,
		MemoryCheckInterval: 20 * time.Millisecond,
		ReadRSS: func(int) (uint64, error) {
			mu.Lock()
			defer mu.Unlock()
			calls++
			if calls%2 == 1 {
				return 5000, nil // spike
			}
			return 100, nil // back to normal
		},
		OnRestart: rec.record,
	})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = proc.Stop(context.Background()) }()

	time.Sleep(400 * time.Millisecond) // ~20 samples, alternating
	if got := rec.snapshot(); len(got) != 0 {
		t.Errorf("alternating spikes restarted the core %d time(s), want 0", len(got))
	}
	if !proc.Running() {
		t.Error("core should still be running")
	}
}

// TestMemoryWatchdogHoldsFireWhileYoung: over the ceiling immediately after a
// start means the ceiling is set below the core's normal footprint. Restarting
// then would just storm, so the watchdog must refuse and leave the process up.
func TestMemoryWatchdogHoldsFireWhileYoung(t *testing.T) {
	shrinkMemoryWindows(t, 1, time.Hour) // nothing is ever old enough
	rec := &restartRecorder{}
	proc := New(Config{
		Name:                "mem-young",
		Binary:              "/bin/sleep",
		Args:                []string{"30"},
		Logger:              newSilentLogger(),
		MaxRestarts:         3,
		RestartBackoff:      10 * time.Millisecond,
		MemoryLimitBytes:    1000,
		MemoryCheckInterval: 20 * time.Millisecond,
		ReadRSS:             func(int) (uint64, error) { return 5000, nil },
		OnRestart:           rec.record,
	})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = proc.Stop(context.Background()) }()

	time.Sleep(300 * time.Millisecond)
	if got := rec.snapshot(); len(got) != 0 {
		t.Errorf("restarted %d time(s) despite the min-uptime guard, want 0", len(got))
	}
	if !proc.Running() {
		t.Error("core must stay up when the ceiling looks misconfigured")
	}
}

// TestMemoryRestartDoesNotSpendCrashBudget: a memory restart is maintenance,
// not a crash. If it consumed the crash budget, a core that legitimately hits
// the ceiling a handful of times over days would eventually be left down.
func TestMemoryRestartDoesNotSpendCrashBudget(t *testing.T) {
	shrinkMemoryWindows(t, 1, 0)
	proc := New(Config{
		Name:                "mem-budget",
		Binary:              "/bin/sleep",
		Args:                []string{"30"},
		Logger:              newSilentLogger(),
		MaxRestarts:         2,
		RestartBackoff:      10 * time.Millisecond,
		MemoryLimitBytes:    1000,
		MemoryCheckInterval: 20 * time.Millisecond,
		ReadRSS:             func(int) (uint64, error) { return 5000, nil },
	})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = proc.Stop(context.Background()) }()

	// Let several memory restarts happen - more than MaxRestarts.
	time.Sleep(600 * time.Millisecond)

	proc.mu.Lock()
	rc := proc.restartCount
	proc.mu.Unlock()
	if rc != 0 {
		t.Errorf("crash budget consumed by memory restarts: restartCount=%d, want 0", rc)
	}
	if !waitFor(t, 2*time.Second, proc.Running) {
		t.Error("core was left down after repeated memory restarts")
	}
}

// TestMemoryWatchdogRefusesWithoutRestartPolicy: killing with no supervisor to
// bring the core back is strictly worse than the OOM we're pre-empting, so the
// watchdog must not arm at all.
func TestMemoryWatchdogRefusesWithoutRestartPolicy(t *testing.T) {
	shrinkMemoryWindows(t, 1, 0)
	proc := New(Config{
		Name:                "mem-no-policy",
		Binary:              "/bin/sleep",
		Args:                []string{"30"},
		Logger:              newSilentLogger(),
		MaxRestarts:         0, // auto-restart disabled
		MemoryLimitBytes:    1000,
		MemoryCheckInterval: 20 * time.Millisecond,
		ReadRSS:             func(int) (uint64, error) { return 5000, nil },
	})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = proc.Stop(context.Background()) }()

	time.Sleep(300 * time.Millisecond)
	if !proc.Running() {
		t.Error("watchdog killed the core with no restart policy to revive it")
	}
}

// TestMemoryWatchdogSurvivesUnreadableRSS: on a platform where RSS can't be
// read the ceiling is simply not enforced. It must not kill anything and must
// not spin the process down.
func TestMemoryWatchdogSurvivesUnreadableRSS(t *testing.T) {
	shrinkMemoryWindows(t, 1, 0)
	rec := &restartRecorder{}
	proc := New(Config{
		Name:                "mem-unreadable",
		Binary:              "/bin/sleep",
		Args:                []string{"30"},
		Logger:              newSilentLogger(),
		MaxRestarts:         3,
		MemoryLimitBytes:    1000,
		MemoryCheckInterval: 20 * time.Millisecond,
		ReadRSS:             func(int) (uint64, error) { return 0, errRSSUnreadableForTest },
		OnRestart:           rec.record,
	})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = proc.Stop(context.Background()) }()

	time.Sleep(200 * time.Millisecond)
	if got := rec.snapshot(); len(got) != 0 {
		t.Errorf("restarted %d time(s) on unreadable RSS, want 0", len(got))
	}
	if !proc.Running() {
		t.Error("core should stay up when RSS can't be sampled")
	}
	if rss := proc.RSSBytes(); rss != 0 {
		t.Errorf("RSSBytes: got %d, want 0 when every read failed", rss)
	}
}

// TestRSSBytesReportsLastSample: the panel shows this next to the ceiling, so
// it has to reflect real samples rather than staying zero.
func TestRSSBytesReportsLastSample(t *testing.T) {
	shrinkMemoryWindows(t, 100, time.Hour) // never restart during this test
	proc := New(Config{
		Name:                "mem-report",
		Binary:              "/bin/sleep",
		Args:                []string{"30"},
		Logger:              newSilentLogger(),
		MaxRestarts:         3,
		MemoryLimitBytes:    1_000_000,
		MemoryCheckInterval: 20 * time.Millisecond,
		ReadRSS:             func(int) (uint64, error) { return 4242, nil },
	})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = proc.Stop(context.Background()) }()

	if !waitFor(t, 2*time.Second, func() bool { return proc.RSSBytes() == 4242 }) {
		t.Errorf("RSSBytes: got %d, want 4242", proc.RSSBytes())
	}
}
