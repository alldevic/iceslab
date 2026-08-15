package xray

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A config the core will not load must never replace one it is already running.
//
// xray refuses a bad config WHOLE: one unusable field takes the user inbounds
// with it, so a node that was serving fine goes dark and then burns its
// crash-restart budget proving the point. On 2026-08-15 the panel sent a
// balancer with no observatory, the agent wrote it over the working config, and
// a live cascade lost both entries for hours. The agent could have refused it
// in the time it takes to run `xray -test`.

// fakeCore stands in for the xray binary: it accepts or rejects a `-test` run
// and records what it was asked.
type fakeCore struct {
	reject bool
	calls  [][]string
}

func (f *fakeCore) run(_ context.Context, _ string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, args)
	if f.reject {
		return []byte("Failed to start: main: failed to create server > core: not all dependencies are resolved."),
			errors.New("exit status 23")
	}
	return []byte("Configuration OK."), nil
}

// stubBinary is something the adapter can actually spawn after a successful
// validation: it just sits there. The validation itself never reaches it, that
// goes through the injected RunCmd, but the adapter is a real one and a real
// one starts the core after writing.
func stubBinary(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "xray-stub")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nsleep 60\n"), 0o755); err != nil {
		t.Fatalf("write stub binary: %v", err)
	}
	return path
}

func validatingAdapter(t *testing.T, core *fakeCore) (*Adapter, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	a := New(Config{
		ConfigPath: path,
		BinaryPath: stubBinary(t, dir),
		RunCmd:     core.run,
		Inbound:    validInbound(),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	return a, path
}

func TestRejectedConfigDoesNotReplaceTheRunningOne(t *testing.T) {
	core := &fakeCore{}
	a, path := validatingAdapter(t, core)

	// A first, accepted push: this is the config the node is serving.
	if err := a.ApplyInbound(443, inboundWire(t, "aaaaaaaa-1111-4000-8000-000000000001", 443)); err != nil {
		t.Fatalf("first ApplyInbound: %v", err)
	}
	good, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config after the good push: %v", err)
	}
	if len(good) == 0 {
		t.Fatal("expected a config on disk after an accepted push")
	}

	// Now the core refuses whatever comes next.
	core.reject = true
	err = a.ApplyInbound(8443, inboundWire(t, "bbbbbbbb-2222-4000-8000-000000000002", 8443))
	if err == nil {
		t.Fatal("expected ApplyInbound to fail when the core rejects the config")
	}
	// The panel has to learn WHY, not just that something went wrong: this
	// string is what an operator reads in the journal and in the panel.
	if !strings.Contains(err.Error(), "not all dependencies are resolved") {
		t.Fatalf("error should carry the core's own words, got: %v", err)
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config after the rejected push: %v", err)
	}
	// The regression this guards: the rejected config used to land on disk, and
	// the running core was restarted into it.
	if string(after) != string(good) {
		t.Fatal("a rejected config replaced the working one on disk")
	}
}

func TestValidationAsksTheCoreBeforeWriting(t *testing.T) {
	core := &fakeCore{}
	a, _ := validatingAdapter(t, core)
	if err := a.ApplyInbound(443, inboundWire(t, "aaaaaaaa-1111-4000-8000-000000000001", 443)); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if len(core.calls) == 0 {
		t.Fatal("expected the core to be asked to test the config")
	}
	// `-test -c <file>`, the same invocation the panel's own config-validity
	// test uses. A different flag spelling would silently validate nothing.
	first := core.calls[0]
	if len(first) < 3 || first[0] != "-test" || first[1] != "-c" {
		t.Fatalf("unexpected test invocation: %v", first)
	}
	// The candidate goes to a temp path, never over the live config, so a
	// rejected one cannot be left behind half-written.
	if strings.Contains(first[2], a.cfg.ConfigPath) {
		t.Fatalf("validation must not test the live config path, got %s", first[2])
	}
}

func TestConfigOnlyModeSkipsValidation(t *testing.T) {
	// No binary: there is nothing to ask and nothing will be started either.
	// The check must not turn a dev/test setup into a hard failure.
	core := &fakeCore{reject: true}
	dir := t.TempDir()
	a := New(Config{
		ConfigPath: filepath.Join(dir, "config.json"),
		RunCmd:     core.run,
		Inbound:    validInbound(),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if err := a.ApplyInbound(443, inboundWire(t, "aaaaaaaa-1111-4000-8000-000000000001", 443)); err != nil {
		t.Fatalf("config-only mode should not validate: %v", err)
	}
	if len(core.calls) != 0 {
		t.Fatalf("expected no core invocation without a binary, got %v", core.calls)
	}
}
