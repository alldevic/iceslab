package xray

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeTwoFacedXray drops a stand-in that PASSES the `run -test` preflight and
// then behaves as `onRun` says when it is run for real.
//
// That split is the whole point. `xray run -test` builds the instance without
// binding anything, so the failures it cannot see are exactly the ones that kill
// the process on the real run - a listen port already taken above all. A fake
// that fails the preflight would be testing the path that already worked.
func writeTwoFacedXray(t *testing.T, onRun string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "xray")
	script := "#!/bin/sh\n" +
		"for a in \"$@\"; do [ \"$a\" = \"-test\" ] && exit 0; done\n" +
		onRun + "\n"
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake xray: %v", err)
	}
	return p
}

func newAdapterWithBinary(t *testing.T, bin string) (*Adapter, *strings.Builder) {
	t.Helper()
	var logged strings.Builder
	logger := slog.New(slog.NewTextHandler(io.MultiWriter(&logged, io.Discard), nil))
	a := New(Config{
		BinaryPath: bin,
		ConfigPath: filepath.Join(t.TempDir(), "config.json"),
		Inbound:    validInbound(),
	}, logger)
	return a, &logged
}

// A core that dies the moment it runs for real must not be reported as started.
//
// Watched live on 2026-08-24 before this existed: xray exited 23 seventeen times
// in a minute and the agent wrote "xray (re)started" at INFO on every cycle, so
// the node's journal read like a healthy machine while nothing was listening.
func TestRegenerate_CoreThatDiesImmediatelyIsNotReportedAsStarted(t *testing.T) {
	a, logged := newAdapterWithBinary(t, writeTwoFacedXray(t, "echo 'failed to listen' >&2; exit 23"))

	err := a.regenerateAndRestart(context.Background())
	if err == nil {
		t.Fatal("a core that exited immediately was reported as a successful start")
	}
	if out := logged.String(); strings.Contains(out, "xray (re)started") {
		t.Errorf("claimed a restart for a dead core; log said:\n%s", out)
	}

	// And the failure is remembered, so re-pushing the same config retries
	// rather than being skipped as unchanged.
	a.mu.Lock()
	failed := a.regenFailed
	a.mu.Unlock()
	if !failed {
		t.Error("regenFailed not set, so an identical re-push would be treated as a no-op")
	}
}

// The control. Without it the case above passes against an agent that never
// manages to start anything at all - including one where the grace check is
// simply inverted.
func TestRegenerate_CoreThatStaysUpIsReportedAsStarted(t *testing.T) {
	a, logged := newAdapterWithBinary(t, writeTwoFacedXray(t, "exec sleep 30"))

	if err := a.regenerateAndRestart(context.Background()); err != nil {
		t.Fatalf("a core that stayed up was reported as failed: %v", err)
	}
	if out := logged.String(); !strings.Contains(out, "xray (re)started") {
		t.Errorf("a genuine start went unlogged; log said:\n%s", out)
	}
	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if proc == nil || !proc.Running() {
		t.Error("the surviving process was not kept as the adapter's core")
	}
	_ = a.Stop(context.Background())
}
