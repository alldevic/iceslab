package xray

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
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

// runBinary runs the stand-in for real, so `-test` goes through it too.
func runBinary(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func newAdapterWithBinary(t *testing.T, bin string) (*Adapter, *strings.Builder) {
	t.Helper()
	var logged strings.Builder
	logger := slog.New(slog.NewTextHandler(io.MultiWriter(&logged, io.Discard), nil))
	a := New(Config{
		BinaryPath: bin,
		ConfigPath: filepath.Join(t.TempDir(), "config.json"),
		RunCmd:     runBinary,
		Inbound:    validInbound(),
	}, logger)
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
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
	if isRefused(err) {
		t.Error("a death after the write must not read as a refusal: the config is on disk")
	}
	out := logged.String()
	if strings.Contains(out, "xray (re)started") {
		t.Errorf("claimed a restart for a dead core; log said:\n%s", out)
	}
	if !strings.Contains(out, "level=ERROR") || !strings.Contains(out, "exited right after starting") {
		t.Errorf("the failure was not logged at Error; log said:\n%s", out)
	}

	// The failure is remembered, so re-pushing the same config retries rather
	// than being skipped as unchanged.
	a.mu.Lock()
	failed := a.lastStartFailed
	a.mu.Unlock()
	if !failed {
		t.Error("lastStartFailed not set, so an identical re-push would be treated as a no-op")
	}
	if a.Healthy() {
		t.Error("a core that died on spawn reports healthy")
	}
	if !a.Provisioned() {
		t.Error("a configured core that is down must stay provisioned")
	}
	if a.Fault() == "" {
		t.Error("Fault() is empty, the panel would be told the core left no reason")
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
	failed := a.lastStartFailed
	a.mu.Unlock()
	if proc == nil || !proc.Running() {
		t.Error("the surviving process was not kept as the adapter's core")
	}
	if failed {
		t.Error("lastStartFailed set after a start that survived the window")
	}
}

// Dies unless the marker file exists; every real run is recorded in starts.
func flakyXray(t *testing.T) (bin, marker, starts string) {
	t.Helper()
	dir := t.TempDir()
	marker = filepath.Join(dir, "stay-up")
	starts = filepath.Join(dir, "starts")
	bin = writeTwoFacedXray(t,
		"echo run >> '"+starts+"'\n"+
			"if [ -e '"+marker+"' ]; then exec sleep 30; fi\n"+
			"echo 'failed to listen' >&2; exit 23")
	return bin, marker, starts
}

func countStarts(t *testing.T, starts string) int {
	t.Helper()
	b, err := os.ReadFile(starts)
	if err != nil {
		if os.IsNotExist(err) {
			return 0
		}
		t.Fatalf("read starts: %v", err)
	}
	return strings.Count(string(b), "run\n")
}

// What an operator does first after a failed push is push it again. The agent
// must try again, not answer "config unchanged" for a core that is down.
func TestApplyInbound_RepeatPushAfterAStartupDeathStartsTheCoreAgain(t *testing.T) {
	const id = "aaaaaaaa-1111-4000-8000-000000000001"
	bin, marker, starts := flakyXray(t)
	a, logged := newAdapterWithBinary(t, bin)
	wire := inboundWire(t, id, 443)

	// 1: the core dies on the real run.
	err := a.ApplyInbound(443, wire)
	if err == nil || isRefused(err) {
		t.Fatalf("first push: want a non-refusal error, got %v", err)
	}
	a.mu.Lock()
	_, held := a.inbounds[id]
	a.mu.Unlock()
	if !held {
		t.Fatal("the inbound left memory, but the disk has it")
	}
	if n := countStarts(t, starts); n != 1 {
		t.Fatalf("after the first push the core ran %d times, want 1", n)
	}

	// 2: the identical push, the core dies again: an error again, not "unchanged".
	if err := a.ApplyInbound(443, wire); err == nil || isRefused(err) {
		t.Fatalf("identical push with a core that dies again: want a non-refusal error, got %v", err)
	}
	if strings.Contains(logged.String(), "config unchanged") {
		t.Fatal("an identical push was skipped as unchanged while the core was down")
	}
	if n := countStarts(t, starts); n != 2 {
		t.Fatalf("after the second push the core ran %d times, want 2", n)
	}

	// 3: this time the core stays up: success with exactly one new start.
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(443, wire); err != nil {
		t.Fatalf("identical push with a core that stays up: %v", err)
	}
	if n := countStarts(t, starts); n != 3 {
		t.Fatalf("the successful push started the core %d times in all, want 3 (one new)", n)
	}
	if !a.Healthy() {
		t.Error("the core is up but reports unhealthy")
	}

	// 4: a third identical push after the success goes the "unchanged" way.
	if err := a.ApplyInbound(443, wire); err != nil {
		t.Fatalf("identical push after success: %v", err)
	}
	if n := countStarts(t, starts); n != 3 {
		t.Fatalf("an identical push after success restarted the core: %d starts, want 3", n)
	}
	if !strings.Contains(logged.String(), "config unchanged") {
		t.Error("the identical push after success did not take the unchanged branch")
	}
}

// repeatPushAfterDeath drives one push entry point through the same story as
// the ApplyInbound test above. The inbound push brings the core up once and it
// dies; `push` is then the policy / DNS / cascade push under test.
//
//	first push        a new value: runs the start, the core dies: error
//	identical repeat  must run the start again and error again, not "unchanged"
//	core stays up     identical push: success, exactly one new start
//	identical again   success and no start
func repeatPushAfterDeath(t *testing.T, push func(a *Adapter) error) {
	t.Helper()
	bin, marker, starts := flakyXray(t)
	a, _ := newAdapterWithBinary(t, bin)

	if err := a.ApplyInbound(443, inboundWire(t, "aaaaaaaa-1111-4000-8000-000000000001", 443)); err == nil {
		t.Fatal("setup: the inbound push with a dying core must fail")
	}
	base := countStarts(t, starts)
	if base != 1 {
		t.Fatalf("setup: %d starts, want 1", base)
	}

	for i := 1; i <= 2; i++ {
		err := push(a)
		if err == nil || isRefused(err) {
			t.Fatalf("push %d with a dying core: want a non-refusal error, got %v", i, err)
		}
		if n := countStarts(t, starts); n != base+i {
			t.Fatalf("after push %d the core ran %d times, want %d", i, n, base+i)
		}
	}

	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := push(a); err != nil {
		t.Fatalf("identical push with a core that stays up: %v", err)
	}
	if n := countStarts(t, starts); n != base+3 {
		t.Fatalf("the successful push left %d starts in all, want %d (one new)", n, base+3)
	}
	if !a.Healthy() {
		t.Error("the core is up but reports unhealthy")
	}

	if err := push(a); err != nil {
		t.Fatalf("identical push after success: %v", err)
	}
	if n := countStarts(t, starts); n != base+3 {
		t.Fatalf("an identical push after success restarted the core: %d starts, want %d", n, base+3)
	}
}

func TestApplyPolicy_RepeatPushAfterAStartupDeathStartsTheCoreAgain(t *testing.T) {
	policy := json.RawMessage(`{"rules":[{"match":{"port":"8443"},"action":{"kind":"block"}}]}`)
	repeatPushAfterDeath(t, func(a *Adapter) error { return a.ApplyPolicy(policy) })
}

func TestApplyDns_RepeatPushAfterAStartupDeathStartsTheCoreAgain(t *testing.T) {
	dns := json.RawMessage(`{"servers":[{"address":"77.88.8.8"}]}`)
	repeatPushAfterDeath(t, func(a *Adapter) error { return a.ApplyDns(dns) })
}

func TestApplyCascade_RepeatPushAfterAStartupDeathStartsTheCoreAgain(t *testing.T) {
	fragments := cascadeFragmentsFixture(t)
	repeatPushAfterDeath(t, func(a *Adapter) error { return a.ApplyCascade(fragments) })
}

// At agent boot a core that dies inside the window must not fail Start: the
// agent has to stay up to report the fault. A push of the same config still
// gets the window error.
func TestStart_CoreThatDiesAtBootKeepsTheAgentUp(t *testing.T) {
	bin, _, starts := flakyXray(t)
	a, logged := newAdapterWithBinary(t, bin)
	if !a.Provisioned() {
		t.Fatal("fixture is not provisioned")
	}

	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start must tolerate a death inside the window, got %v", err)
	}
	out := logged.String()
	if !strings.Contains(out, "level=ERROR") || strings.Contains(out, "xray (re)started") {
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
	err := a.ApplyInbound(443, inboundWire(t, "aaaaaaaa-1111-4000-8000-000000000001", 443))
	if !errors.Is(err, subprocess.ErrDiedInStartup) {
		t.Fatalf("push after a boot death: want the window error, got %v", err)
	}
	if n := countStarts(t, starts); n != 2 {
		t.Errorf("core ran %d times, want 2", n)
	}
}
