package hysteria

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

// lockedBuf: the supervisor logs from its own goroutine while the test reads.
type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

const startupWire = `{"hostname":"node.example.test","obfsPassword":"p"}`

// spawnFixture: an adapter in spawn mode (no ServiceUnit) over a stand-in
// hysteria that records every run in starts and dies at once unless the marker
// file exists. The stand-in has no preflight: hysteria is not asked to check
// its config before the real run.
func spawnFixture(t *testing.T) (a *Adapter, logged *lockedBuf, marker, starts string) {
	t.Helper()
	dir := t.TempDir()
	marker = filepath.Join(dir, "stay-up")
	starts = filepath.Join(dir, "starts")
	bin := filepath.Join(dir, "hysteria")
	script := "#!/bin/sh\n" +
		"echo run >> '" + starts + "'\n" +
		"if [ -e '" + marker + "' ]; then exec sleep 30; fi\n" +
		"echo 'listen udp :443: address already in use' >&2; exit 1\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	logged = &lockedBuf{}
	a = New(Config{
		BinaryPath:       bin,
		ConfigPath:       filepath.Join(dir, "config.yaml"),
		AuthCallbackPort: freeTCP(t),
	}, slog.New(slog.NewTextHandler(io.MultiWriter(logged, io.Discard), nil)))
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	return a, logged, marker, starts
}

func runs(t *testing.T, starts string) int {
	t.Helper()
	b, err := os.ReadFile(starts)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return strings.Count(string(b), "run\n")
}

// hysteria that dies the moment it runs (a taken UDP port) is not a started core.
func TestStart_CoreThatDiesImmediatelyIsNotReportedAsStarted(t *testing.T) {
	a, logged, _, _ := spawnFixture(t)

	// Boot tolerates the death: the agent must stay up to report the fault.
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start must tolerate a death inside the window, got %v", err)
	}
	out := logged.String()
	if strings.Contains(out, "hysteria started") {
		t.Errorf("claimed a start for a dead core; log said:\n%s", out)
	}
	if !strings.Contains(out, "level=ERROR") || !strings.Contains(out, "exited right after starting") {
		t.Errorf("the failure was not logged at Error; log said:\n%s", out)
	}
	a.mu.RLock()
	failed := a.lastStartFailed
	a.mu.RUnlock()
	if !failed {
		t.Error("lastStartFailed not set")
	}
	if a.Fault() == "" {
		t.Error("Fault() is empty, the panel would be told the core left no reason")
	}
	if a.Healthy() {
		t.Error("a core that died on spawn reports healthy")
	}
}

// The control: without it the case above passes against an adapter that never
// manages to start anything.
func TestStart_CoreThatStaysUpIsReportedAsStarted(t *testing.T) {
	a, logged, marker, _ := spawnFixture(t)
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("a core that stayed up was reported as failed: %v", err)
	}
	if !strings.Contains(logged.String(), "hysteria started") {
		t.Errorf("a genuine start went unlogged; log said:\n%s", logged.String())
	}
	a.mu.RLock()
	failed := a.lastStartFailed
	a.mu.RUnlock()
	if failed {
		t.Error("lastStartFailed set after a start that survived the window")
	}
	if a.Fault() != "" || !a.Healthy() {
		t.Errorf("a live core: fault %q healthy %v", a.Fault(), a.Healthy())
	}
}

// After a start that died, pushing the same inbound again must spawn again, not
// answer "unchanged" for a core that is down.
func TestApplyInbound_RepeatPushAfterAStartupDeathSpawnsTheCoreAgain(t *testing.T) {
	a, logged, marker, starts := spawnFixture(t)

	// Boot tolerates the death; the pushes below still get the window error.
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	if n := runs(t, starts); n != 1 {
		t.Fatalf("after Start the core ran %d times, want 1", n)
	}
	// The first push is new to the adapter, the second is identical to it.
	for i := 2; i <= 3; i++ {
		if err := a.ApplyInbound(443, []byte(startupWire)); !errors.Is(err, subprocess.ErrDiedInStartup) {
			t.Fatalf("push with a core that dies again: want the window error, got %v", err)
		}
		if n := runs(t, starts); n != i {
			t.Fatalf("after push %d the core ran %d times, want %d", i-1, n, i)
		}
	}
	if strings.Contains(logged.String(), "config unchanged") {
		t.Fatal("an identical push was skipped as unchanged while the core was down")
	}

	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(443, []byte(startupWire)); err != nil {
		t.Fatalf("identical push with a core that stays up: %v", err)
	}
	if n := runs(t, starts); n != 4 {
		t.Fatalf("the successful push left %d runs in all, want 4", n)
	}
	if !a.Healthy() {
		t.Error("the core is up but reports unhealthy")
	}
	if err := a.ApplyInbound(443, []byte(startupWire)); err != nil {
		t.Fatalf("identical push after success: %v", err)
	}
	if n := runs(t, starts); n != 4 {
		t.Fatalf("an identical push after success spawned again: %d runs, want 4", n)
	}
	if !strings.Contains(logged.String(), "config unchanged") {
		t.Error("the identical push after success did not take the unchanged branch")
	}
}

// Under systemd nothing is spawned here: the window is not on that path, and a
// start there is not failed by it.
func TestStart_SystemdModeSpawnsNothingAndHasNoWindow(t *testing.T) {
	a, _, _, starts := spawnFixture(t)
	a.cfg.ServiceUnit = "hysteria-server.service"
	a.cfg.RunCmd = func(context.Context, string, ...string) error { return nil }
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("systemd mode start: %v", err)
	}
	if n := runs(t, starts); n != 0 {
		t.Fatalf("systemd mode spawned the binary %d times", n)
	}
}
