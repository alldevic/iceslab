package xray

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// pidLog is the stub's record of every process it started: each run appends its
// pid and then becomes `sleep`, so the pid stays the process's own.
func pidLoggingXray(t *testing.T) (bin, pidFile string) {
	t.Helper()
	pidFile = filepath.Join(t.TempDir(), "pids")
	return writeTwoFacedXray(t, "echo $$ >> "+pidFile+"; exec sleep 30"), pidFile
}

func readPids(t *testing.T, path string) []int {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []int
	for _, f := range strings.Fields(string(raw)) {
		n, err := strconv.Atoi(f)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, n)
	}
	return out
}

func pidAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// The 10.2 stand defect: a geo-triggered restart ran under the push's ctx, the
// handler returned, the ctx ended and exec.CommandContext killed the NEW xray
// ("signal: killed"), leaving none. Exactly one process must remain, the new
// one, after the push's ctx is gone.
func TestFlushGeoRestartOutlivesThePushContext(t *testing.T) {
	bin, pidFile := pidLoggingXray(t)
	a, _ := newAdapterWithBinary(t, bin)
	if err := a.regenerateAndRestart(context.Background()); err != nil {
		t.Fatal(err)
	}

	a.NoteGeo("iceslab-mine.dat=bb")
	push, endPush := context.WithCancel(context.Background())
	if err := a.FlushGeo(push); err != nil {
		t.Fatal(err)
	}
	endPush() // the HTTP handler returned

	// Long enough for a kill to land and the supervisor to (not) respawn.
	time.Sleep(600 * time.Millisecond)

	pids := readPids(t, pidFile)
	if len(pids) != 2 {
		t.Fatalf("started %d processes, want 2 (boot + the geo restart): %v", len(pids), pids)
	}
	if pidAlive(pids[0]) {
		t.Errorf("the old process %d is still alive", pids[0])
	}
	if !pidAlive(pids[1]) {
		t.Fatalf("the new process %d died with the push's context", pids[1])
	}
	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if proc == nil || !proc.Running() || !a.Healthy() {
		t.Error("the adapter does not report the new process as running")
	}
}

// A core that died after it had passed the startup window is not "unchanged":
// the same push starts it again, for every apply that has an unchanged check.
func TestUnchangedConfigWithADeadCoreStartsItAgain(t *testing.T) {
	bin, pidFile := pidLoggingXray(t)
	a, _ := newAdapterWithBinary(t, bin)
	const id = "aaaaaaaa-1111-4000-8000-000000000001"
	raw := inboundWire(t, id, 443)
	if err := a.ApplyInbound(443, raw); err != nil {
		t.Fatal(err)
	}
	pids := readPids(t, pidFile)
	if len(pids) != 1 {
		t.Fatalf("boot started %v", pids)
	}

	// Kill it for good: the supervisor is stopped first so it cannot respawn
	// (the budget-exhausted / cancelled-respawn end state of the stand).
	a.mu.Lock()
	dead := a.proc
	a.mu.Unlock()
	if err := dead.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the process to be gone", func() bool { return !pidAlive(pids[0]) })
	if a.Healthy() {
		t.Fatal("setup: the core still reports healthy")
	}
	a.mu.Lock()
	failedFlag := a.lastStartFailed
	a.mu.Unlock()
	if failedFlag {
		t.Fatal("setup: lastStartFailed is set, the case is not the late death")
	}

	if err := a.ApplyInbound(443, raw); err != nil {
		t.Fatal(err)
	}
	pids = readPids(t, pidFile)
	if len(pids) != 2 || !pidAlive(pids[1]) {
		t.Fatalf("an unchanged push left the dead core dead: %v", pids)
	}
	if !a.Healthy() {
		t.Error("the restarted core does not report healthy")
	}

	// And a push that really is unchanged, with the core up, still does nothing.
	if err := a.ApplyInbound(443, raw); err != nil {
		t.Fatal(err)
	}
	if got := readPids(t, pidFile); len(got) != 2 {
		t.Errorf("an unchanged push with a live core restarted it: %v", got)
	}
}
