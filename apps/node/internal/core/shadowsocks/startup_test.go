package shadowsocks

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

// startupFixture: a stand-in xray that records every real run in starts and
// dies at once unless the marker file exists.
func startupFixture(t *testing.T) (a *Adapter, logged *lockedBuf, marker, starts string, wire []byte) {
	t.Helper()
	dir := t.TempDir()
	marker = filepath.Join(dir, "stay-up")
	starts = filepath.Join(dir, "starts")
	bin := filepath.Join(dir, "xray")
	script := "#!/bin/sh\n" +
		"echo run >> '" + starts + "'\n" +
		"if [ -e '" + marker + "' ]; then exec sleep 30; fi\n" +
		"echo 'listen tcp :443: address already in use' >&2; exit 1\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	logged = &lockedBuf{}
	a = New(Config{BinaryPath: bin, ConfigPath: filepath.Join(dir, "config.json")},
		slog.New(slog.NewTextHandler(io.MultiWriter(logged, io.Discard), nil)))
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	wire = []byte(`{"method":"2022-blake3-aes-256-gcm","serverPsk":"BASE64-FAKE-SERVER-PSK=="}`)
	return a, logged, marker, starts, wire
}

func runs(t *testing.T, starts string) int {
	t.Helper()
	b, err := os.ReadFile(starts)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return strings.Count(string(b), "run\n")
}

// xray that dies the moment it runs (a taken port) is not a started core.
func TestApplyInbound_CoreThatDiesImmediatelyIsNotReportedAsStarted(t *testing.T) {
	a, logged, _, _, wire := startupFixture(t)

	if err := a.ApplyInbound(443, wire); err == nil {
		t.Fatal("a core that exited immediately was reported as a successful start")
	}
	out := logged.String()
	if strings.Contains(out, "(re)started") {
		t.Errorf("claimed a start for a dead core; log said:\n%s", out)
	}
	if !strings.Contains(out, "level=ERROR") || !strings.Contains(out, "exited right after starting") {
		t.Errorf("the failure was not logged at Error; log said:\n%s", out)
	}
	a.mu.Lock()
	failed := a.lastStartFailed
	a.mu.Unlock()
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
func TestApplyInbound_CoreThatStaysUpIsReportedAsStarted(t *testing.T) {
	a, logged, marker, _, wire := startupFixture(t)
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(443, wire); err != nil {
		t.Fatalf("a core that stayed up was reported as failed: %v", err)
	}
	if !strings.Contains(logged.String(), "shadowsocks (xray) (re)started") {
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
	a, logged, marker, starts, wire := startupFixture(t)

	if err := a.ApplyInbound(443, wire); err == nil {
		t.Fatal("first push: want an error")
	}
	if n := runs(t, starts); n != 1 {
		t.Fatalf("after the first push the core ran %d times, want 1", n)
	}
	if err := a.ApplyInbound(443, wire); err == nil {
		t.Fatal("identical push with a core that dies again: want an error")
	}
	if strings.Contains(logged.String(), "config unchanged") {
		t.Fatal("an identical push was skipped as unchanged while the core was down")
	}
	if n := runs(t, starts); n != 2 {
		t.Fatalf("after the second push the core ran %d times, want 2", n)
	}

	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(443, wire); err != nil {
		t.Fatalf("identical push with a core that stays up: %v", err)
	}
	if n := runs(t, starts); n != 3 {
		t.Fatalf("the successful push left %d runs in all, want 3", n)
	}
	if err := a.ApplyInbound(443, wire); err != nil {
		t.Fatalf("identical push after success: %v", err)
	}
	if n := runs(t, starts); n != 3 {
		t.Fatalf("an identical push after success restarted the core: %d runs, want 3", n)
	}
	if !strings.Contains(logged.String(), "config unchanged") {
		t.Error("the identical push after success did not take the unchanged branch")
	}
}

// At agent boot a core that dies inside the window must not fail Start: the
// agent has to stay up to report the fault. A push of the same config still
// gets the window error.
func TestStart_CoreThatDiesAtBootKeepsTheAgentUp(t *testing.T) {
	a, logged, _, starts, wire := startupFixture(t)
	a.cfg.Inbound.Method = "2022-blake3-aes-256-gcm"
	a.cfg.Inbound.ServerPSK = "BASE64-FAKE-SERVER-PSK=="

	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start must tolerate a death inside the window, got %v", err)
	}
	out := logged.String()
	if !strings.Contains(out, "level=ERROR") || strings.Contains(out, "(re)started") {
		t.Errorf("want an Error line and no started line; log said:\n%s", out)
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
	err := a.ApplyInbound(443, wire)
	if !errors.Is(err, subprocess.ErrDiedInStartup) {
		t.Fatalf("push after a boot death: want the window error, got %v", err)
	}
	if n := runs(t, starts); n != 2 {
		t.Errorf("the push did not start the core again: %d runs, want 2", n)
	}
}
