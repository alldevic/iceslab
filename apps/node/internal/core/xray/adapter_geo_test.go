package xray

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

// writeFakeXray drops an executable stand-in for the xray binary that emulates
// `run -test`: it exits non-zero when the config contains `rejectMarker`, else 0.
func writeFakeXray(t *testing.T, rejectMarker string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "xray")
	script := "#!/bin/sh\n" +
		"cfg=\"\"\n" +
		"while [ $# -gt 0 ]; do case \"$1\" in -c) shift; cfg=\"$1\";; esac; shift; done\n" +
		"if grep -q '" + rejectMarker + "' \"$cfg\" 2>/dev/null; then echo 'geosite: category not found' >&2; exit 1; fi\n" +
		"exit 0\n"
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake xray: %v", err)
	}
	return p
}

// §3.2: the xray -test preflight accepts a loadable config and rejects one xray
// cannot boot, carrying the failure reason, and leaves no scratch file behind.
func TestTestXrayConfig(t *testing.T) {
	bin := writeFakeXray(t, "BADCAT")
	dir := t.TempDir()
	ctx := context.Background()

	if err := testXrayConfig(ctx, bin, dir, []byte(`{"routing":{"rules":[]}}`), nil); err != nil {
		t.Errorf("valid config rejected: %v", err)
	}

	err := testXrayConfig(ctx, bin, dir, []byte(`{"rule":"geosite:BADCAT"}`), nil)
	if err == nil {
		t.Fatal("bad config accepted; want rejection")
	}
	if !strings.Contains(err.Error(), "category not found") {
		t.Errorf("error should carry xray's stderr, got: %v", err)
	}

	// No scratch config leaks (defer os.Remove ran).
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "xray-test-") {
			t.Errorf("scratch config not cleaned up: %s", e.Name())
		}
	}
}

// §3.2 safety net: when the preflight rejects the candidate config,
// regenerateAndRestart must NOT stop the running instance - the entry hop keeps
// serving instead of crash-looping the supervisor into an outage.
func TestRegenerate_RejectedConfigKeepsOldProcessRunning(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	bin := writeFakeXray(t, "vless-in") // rejects the real rendered config (has a vless-in inbound)
	a := New(Config{
		BinaryPath: bin,
		ConfigPath: filepath.Join(t.TempDir(), "config.json"),
		Inbound:    validInbound(),
	}, logger)

	// A running stand-in as the "old" instance.
	old := subprocess.New(subprocess.Config{
		Name: "xray-old", Binary: "/bin/sleep", Args: []string{"30"}, Logger: logger,
	})
	if err := old.Start(context.Background()); err != nil {
		t.Fatalf("start old stub: %v", err)
	}
	defer func() { _ = old.Stop(context.Background()) }()
	a.mu.Lock()
	a.proc = old
	a.mu.Unlock()

	if err := a.regenerateAndRestart(context.Background()); err == nil {
		t.Fatal("regenerateAndRestart accepted a config the preflight rejects")
	}

	// The old instance is untouched (never stopped, never replaced).
	a.mu.Lock()
	same := a.proc == old
	a.mu.Unlock()
	if !same {
		t.Error("old proc was replaced despite a rejected config")
	}
	if !old.Running() {
		t.Error("old proc was stopped despite a rejected config (would be an outage)")
	}
}

// §3.2 (round-4 gap): liveUpdateUser is a SECOND writer to the config path. When
// the last regenerate failed its -test (regenFailed set), the on-disk config is
// the last-good one; a routine live user add/remove must NOT overwrite it with
// the unbootable render, or a later crash-respawn would boot-loop the poisoned
// disk. The live adu/rmu against the healthy running xray must still run.
func TestLiveUpdate_KeepsLastGoodDiskWhenRegenFailed(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.json")
	sentinel := []byte(`{"last":"good"}`)
	if err := os.WriteFile(cfgPath, sentinel, 0o600); err != nil {
		t.Fatalf("seed config: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	var calls [][]string
	a := New(Config{
		BinaryPath: "/usr/bin/xray", // never exec'd on the live path (RunCmd is mocked)
		ConfigPath: cfgPath,
		Inbound:    validInbound(),
		RunCmd: func(_ context.Context, name string, args ...string) ([]byte, error) {
			calls = append(calls, append([]string{name}, args...))
			return []byte("Added 1 user(s) in total."), nil
		},
	}, logger)
	// A running stand-in so the live path is taken; regenFailed marks the current
	// inbound+cascade unbootable.
	a.proc = subprocess.New(subprocess.Config{
		Name: "xray", Binary: "/bin/sleep", Args: []string{"30"}, Logger: logger,
	})
	if err := a.proc.Start(context.Background()); err != nil {
		t.Fatalf("start stub: %v", err)
	}
	defer func() { _ = a.proc.Stop(context.Background()) }()
	a.mu.Lock()
	a.regenFailed = true
	a.mu.Unlock()

	if err := a.AddUser(core.User{UserID: "u", XrayUUID: "uuid-u"}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}

	// Disk kept the last-good config (the second writer did not poison it).
	got, _ := os.ReadFile(cfgPath)
	if !bytes.Equal(got, sentinel) {
		t.Errorf("on-disk config overwritten while regenFailed; want last-good sentinel, got %q", got)
	}
	// The live add still ran against the healthy running xray.
	sawAdu := false
	for _, c := range calls {
		if strings.Contains(strings.Join(c, " "), "api adu") {
			sawAdu = true
		}
	}
	if !sawAdu {
		t.Error("expected a live `api adu` against the running xray")
	}
}
