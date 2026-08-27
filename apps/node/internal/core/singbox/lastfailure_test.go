package singbox

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

// Why tuic is down, as the panel gets to say it.
//
// composeDownMessage prints `not running: <core> (<reason>)`, and the reason is
// the last line the core printed. Six adapters own a subprocess; until now ONE
// of them reported that line, so for the other five the panel had a name and
// nothing else — which is the state §45 already called out as true and useless.
//
// Tested per adapter rather than once, because the body is a delegation and a
// delegation is exactly what silently reads the wrong field. Same reasoning as
// the eight runCmd copies: identical code is not tested code.

// deadCore starts a process that fails the way a core fails — a line on STDERR
// and a non-zero exit — and returns it once the reader goroutine has recorded
// that line. No fake binary on disk: /bin/sh is the fixture.
func deadCore(t *testing.T) *subprocess.Subprocess {
	t.Helper()
	proc := subprocess.New(subprocess.Config{
		Name:   "fake-singbox",
		Binary: "/bin/sh",
		Args:   []string{"-c", "echo 'listen tcp 0.0.0.0:8443: bind: address already in use' >&2; exit 23"},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("fixture: %v", err)
	}
	// The pipe reader runs on its own goroutine, so the line lands after the
	// process is already gone. Waiting for the LINE rather than for the exit is
	// what keeps this from failing by scheduler.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if proc.LastLine() != "" {
			return proc
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("fixture: the fake core printed nothing the subprocess recorded")
	return nil
}

func TestLastFailure_CarriesWhatTheCorePrintedOnItsWayOut(t *testing.T) {
	a := lastFailureAdapter(t)
	if got := a.LastFailure(); got != "" {
		t.Errorf("LastFailure() = %q on an adapter that owns no process", got)
	}

	a.mu.Lock()
	a.proc = deadCore(t)
	a.mu.Unlock()

	got := a.LastFailure()
	if !strings.Contains(got, "address already in use") {
		t.Errorf("LastFailure() = %q; the panel would show a core that is down for no stated reason", got)
	}
}

// The control. Without it the case above passes against an implementation that
// returns a constant, and against one that keeps answering from a core it has
// already dropped.
func TestLastFailure_EmptyOnceTheProcessIsGone(t *testing.T) {
	a := lastFailureAdapter(t)
	a.mu.Lock()
	a.proc = deadCore(t)
	a.mu.Unlock()
	if a.LastFailure() == "" {
		t.Fatal("the fixture did not take; the rest of this case proves nothing")
	}

	a.mu.Lock()
	a.proc = nil
	a.mu.Unlock()
	if got := a.LastFailure(); got != "" {
		t.Errorf("LastFailure() = %q after the adapter stopped owning the process", got)
	}
}

func lastFailureAdapter(t *testing.T) *Adapter { t.Helper(); return testAdapter() }
