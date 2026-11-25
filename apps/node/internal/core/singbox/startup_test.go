package singbox

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

const startupWire = `{"serverName":"n.example.test"}`

// startupFixture: a started adapter over a stand-in sing-box that PASSES the
// `check` preflight (and answers `version`) and, run for real, records the run
// in starts and dies at once unless the marker file exists. A fake that failed
// the preflight would test the refusal path, which already worked.
func startupFixture(t *testing.T) (a *Adapter, logged *lockedBuf, marker, starts string) {
	t.Helper()
	dir := t.TempDir()
	marker = filepath.Join(dir, "stay-up")
	starts = filepath.Join(dir, "starts")
	bin := filepath.Join(dir, "sing-box-stub")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = version ]; then echo 'sing-box version 1.13.14'; exit 0; fi\n" +
		"if [ \"$1\" = check ]; then exit 0; fi\n" +
		"echo start >> '" + starts + "'\n" +
		"if [ -e '" + marker + "' ]; then exec sleep 30; fi\n" +
		"echo 'listen udp :9443: address already in use' >&2; exit 1\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	logged = &lockedBuf{}
	a = New(Config{
		Protocol:   "tuic",
		BinaryPath: bin,
		ConfigPath: filepath.Join(dir, "config.json"),
	}, slog.New(slog.NewTextHandler(io.MultiWriter(logged, io.Discard), nil)))
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	return a, logged, marker, starts
}

// A core that dies the moment it runs for real (a taken port) is not a started core.
func TestApplyInbound_CoreThatDiesImmediatelyIsNotReportedAsStarted(t *testing.T) {
	a, logged, _, _ := startupFixture(t)

	err := a.ApplyInbound(9443, []byte(startupWire))
	if err == nil {
		t.Fatal("a core that exited immediately was reported as a successful start")
	}
	var refused *refusedError
	if errors.As(err, &refused) {
		t.Error("a death after the write must not read as a refusal: the config is on disk")
	}
	out := logged.String()
	if strings.Contains(out, "config applied and (re)started") {
		t.Errorf("claimed a start for a dead core; log said:\n%s", out)
	}
	if !strings.Contains(out, "level=ERROR") || !strings.Contains(out, "exited right after starting") {
		t.Errorf("the failure was not logged at Error; log said:\n%s", out)
	}
	a.mu.Lock()
	failed := a.lastStartFailed
	_, held := a.inbounds[""]
	a.mu.Unlock()
	if !failed {
		t.Error("lastStartFailed not set")
	}
	if !held {
		t.Error("the inbound left memory, but the disk has it")
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
func TestApplyInbound_CoreThatStaysUpIsReportedAsStarted(t *testing.T) {
	a, logged, marker, _ := startupFixture(t)
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(9443, []byte(startupWire)); err != nil {
		t.Fatalf("a core that stayed up was reported as failed: %v", err)
	}
	if !strings.Contains(logged.String(), "config applied and (re)started") {
		t.Errorf("a genuine start went unlogged; log said:\n%s", logged.String())
	}
	a.mu.Lock()
	failed := a.lastStartFailed
	a.mu.Unlock()
	if failed {
		t.Error("lastStartFailed set after a start that survived the window")
	}
	if a.Fault() != "" || !a.Healthy() {
		t.Errorf("a live core: fault %q healthy %v", a.Fault(), a.Healthy())
	}
}

// What an operator does first after a failed push is push it again.
func TestApplyInbound_RepeatPushAfterAStartupDeathStartsTheCoreAgain(t *testing.T) {
	a, logged, marker, starts := startupFixture(t)
	wire := []byte(startupWire)

	if err := a.ApplyInbound(9443, wire); err == nil {
		t.Fatal("first push: want an error")
	}
	if n := startCount(starts); n != 1 {
		t.Fatalf("after the first push the core ran %d times, want 1", n)
	}
	if err := a.ApplyInbound(9443, wire); err == nil {
		t.Fatal("identical push with a core that dies again: want an error")
	}
	if strings.Contains(logged.String(), "config unchanged") {
		t.Fatal("an identical push was skipped as unchanged while the core was down")
	}
	if n := startCount(starts); n != 2 {
		t.Fatalf("after the second push the core ran %d times, want 2", n)
	}

	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(9443, wire); err != nil {
		t.Fatalf("identical push with a core that stays up: %v", err)
	}
	if n := startCount(starts); n != 3 {
		t.Fatalf("the successful push left %d runs in all, want 3", n)
	}
	if err := a.ApplyInbound(9443, wire); err != nil {
		t.Fatalf("identical push after success: %v", err)
	}
	if n := startCount(starts); n != 3 {
		t.Fatalf("an identical push after success restarted the core: %d runs, want 3", n)
	}
	if !strings.Contains(logged.String(), "config unchanged") {
		t.Error("the identical push after success did not take the unchanged branch")
	}
}

// At agent boot (inbounds already held) a core that dies inside the window must
// not fail Start: the agent has to stay up to report the fault. A push of the
// same config still gets the window error.
func TestStart_CoreThatDiesAtBootKeepsTheAgentUp(t *testing.T) {
	a, logged, _, starts := startupFixture(t)
	if err := a.ApplyInbound(9443, []byte(startupWire)); !errors.Is(err, subprocess.ErrDiedInStartup) {
		t.Fatalf("first push: want the window error, got %v", err)
	}
	before := logged.String()

	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start must tolerate a death inside the window, got %v", err)
	}
	if strings.Contains(logged.String()[len(before):], "config applied and (re)started") {
		t.Error("claimed a start for a dead core")
	}
	a.mu.Lock()
	failed := a.lastStartFailed
	a.mu.Unlock()
	if !failed {
		t.Error("lastStartFailed not set")
	}
	if a.Fault() == "" {
		t.Error("Fault() is empty")
	}
	if a.Healthy() {
		t.Error("a dead core reports healthy")
	}
	if err := a.ApplyInbound(9443, []byte(startupWire)); !errors.Is(err, subprocess.ErrDiedInStartup) {
		t.Fatalf("push after a boot death: want the window error, got %v", err)
	}
	if n := strings.Count(readFile(t, starts), "start\n"); n != 3 {
		t.Errorf("core ran %d times, want 3 (push, boot, push)", n)
	}
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return string(b)
}
