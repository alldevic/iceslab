//go:build unix

package subprocess

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The escalation nobody had ever watched happen.
//
// Start puts every core in its OWN process group (Setpgid), and Stop signals
// the GROUP, not the pid. Both halves matter and neither is visible from the
// code alone:
//
//   - a core that forks a helper (hysteria's ACME client, xray's plugins) makes
//     the helper a grandchild. Signalling the leader alone leaves the grandchild
//     alive, still holding :443, and the restart then fails on "address already
//     in use" — a node that goes down and cannot come back up.
//   - a core that ignores SIGTERM would be waited on forever if the SIGKILL
//     escalation did not fire. killGroup is that escalation, and it was the one
//     line in this package no test had ever reached.
//
// So the test does not check that a kill was "called". It starts real
// processes that refuse SIGTERM, records their pids, stops them, and asks the
// kernel whether they still exist.

// alive reports whether a pid still exists. Signal 0 performs the permission
// and existence checks and delivers nothing.
func alive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

func waitGone(pid int, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if !alive(pid) {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return !alive(pid)
}

// readPids waits for the script to report both pids, one per line.
func readPids(t *testing.T, path string) (parent, child int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		blob, err := os.ReadFile(path)
		if err == nil {
			lines := strings.Fields(string(blob))
			if len(lines) >= 2 {
				parent, _ = strconv.Atoi(lines[0])
				child, _ = strconv.Atoi(lines[1])
				if parent > 0 && child > 0 {
					return parent, child
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the test process never reported its pids into %s", path)
	return 0, 0
}

func TestStop_SIGKILLsTheWholeGroupWhenSIGTERMIsIgnored(t *testing.T) {
	if testing.Short() {
		t.Skip("waits out the " + StopGracePeriod.String() + " grace period")
	}
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "pids")

	// A parent that ignores SIGTERM, with a grandchild that ignores it too.
	// Both must be gone once Stop returns.
	script := fmt.Sprintf(
		`trap '' TERM; sh -c 'trap "" TERM; sleep 60' & printf '%%s\n%%s\n' "$$" "$!" > %s; wait`,
		pidFile)

	proc := New(Config{
		Name:   "stubborn",
		Binary: "/bin/sh",
		Args:   []string{"-c", script},
		Logger: newSilentLogger(),
	})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	parent, child := readPids(t, pidFile)
	if !alive(parent) || !alive(child) {
		t.Fatalf("the fixture did not stay up: parent alive=%v child alive=%v", alive(parent), alive(child))
	}

	start := time.Now()
	err := proc.Stop(context.Background())
	elapsed := time.Since(start)

	// Stop must SAY it had to kill. Reporting nil here is how a node that never
	// shut down cleanly looks identical to one that did.
	if err == nil {
		t.Error("Stop returned nil for a process that ignored SIGTERM and had to be killed")
	} else if !strings.Contains(err.Error(), "killed") {
		t.Errorf("error should say it killed the core, got %v", err)
	}
	if elapsed < StopGracePeriod {
		t.Errorf("Stop returned after %s, before the %s grace period was up", elapsed, StopGracePeriod)
	}

	if !waitGone(parent, 2*time.Second) {
		t.Errorf("pid %d (the core itself) survived Stop", parent)
	}
	// The one that the group signal exists for.
	if !waitGone(child, 2*time.Second) {
		t.Errorf("pid %d (a grandchild in the same group) survived Stop; it would still hold the core's port", child)
	}
}

// The control for the test above: a core that HONOURS SIGTERM must be reaped by
// the terminate step, well inside the grace period and without an error. If
// both cases went through the kill path, the test above would prove nothing
// about the escalation being conditional.
func TestStop_SIGTERMAloneSufficesForACoreThatHonoursIt(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "pids")
	script := fmt.Sprintf(`sleep 60 & printf '%%s\n%%s\n' "$$" "$!" > %s; wait`, pidFile)

	proc := New(Config{
		Name:   "polite",
		Binary: "/bin/sh",
		Args:   []string{"-c", script},
		Logger: newSilentLogger(),
	})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	parent, child := readPids(t, pidFile)

	start := time.Now()
	if err := proc.Stop(context.Background()); err != nil {
		t.Errorf("Stop: %v", err)
	}
	if elapsed := time.Since(start); elapsed >= StopGracePeriod {
		t.Errorf("Stop took %s: it waited out the grace period for a process that honours SIGTERM", elapsed)
	}
	if !waitGone(parent, 2*time.Second) {
		t.Errorf("pid %d survived a graceful Stop", parent)
	}
	if !waitGone(child, 2*time.Second) {
		t.Errorf("grandchild pid %d survived a graceful Stop", child)
	}
}
