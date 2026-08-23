package zapret2

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// recorder is a fake RunCmdFunc that records every invocation.
type recorder struct {
	calls [][]string // each entry is [name, args...]
}

func (r *recorder) run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, append([]string{name}, args...))
	return nil, nil
}

func TestApply_NoConfigPathIsInert(t *testing.T) {
	rec := &recorder{}
	m := New(Config{RunCmd: rec.run, UpCmd: []string{"up"}}, testLogger())

	changed, err := m.Apply(true, "NFQWS2_ENABLE=1")
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if changed {
		t.Errorf("no ConfigPath: want changed=false")
	}
	if len(rec.calls) != 0 {
		t.Errorf("no ConfigPath: must not exec, got %v", rec.calls)
	}
}

func TestApply_EnabledWritesConfigAndRunsUp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config")
	rec := &recorder{}
	m := New(Config{
		ConfigPath: path,
		UpCmd:      []string{"docker", "compose", "up", "-d"},
		DownCmd:    []string{"docker", "compose", "down"},
		RunCmd:     rec.run,
	}, testLogger())

	body := "NFQWS2_ENABLE=1\nNFQWS2_PORTS_TCP=80,443\n"
	changed, err := m.Apply(true, body)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !changed {
		t.Errorf("first enable: want changed=true")
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(got) != body {
		t.Errorf("config body: got %q want %q", got, body)
	}
	if len(rec.calls) != 1 || rec.calls[0][0] != "docker" || rec.calls[0][len(rec.calls[0])-1] != "-d" {
		t.Errorf("expected one up call (docker compose up -d), got %v", rec.calls)
	}
}

func TestApply_IdempotentSkipsSecondIdenticalPush(t *testing.T) {
	dir := t.TempDir()
	rec := &recorder{}
	m := New(Config{
		ConfigPath: filepath.Join(dir, "config"),
		UpCmd:      []string{"up"},
		RunCmd:     rec.run,
	}, testLogger())

	body := "NFQWS2_ENABLE=1\n"
	if _, err := m.Apply(true, body); err != nil {
		t.Fatalf("first Apply: %v", err)
	}
	changed, err := m.Apply(true, body)
	if err != nil {
		t.Fatalf("second Apply: %v", err)
	}
	if changed {
		t.Errorf("identical re-push: want changed=false (idempotent)")
	}
	if len(rec.calls) != 1 {
		t.Errorf("identical re-push must not re-exec: got %d calls", len(rec.calls))
	}
}

func TestApply_ConfigChangeReapplies(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config")
	rec := &recorder{}
	m := New(Config{ConfigPath: path, UpCmd: []string{"up"}, RunCmd: rec.run}, testLogger())

	if _, err := m.Apply(true, "NFQWS2_PORTS_TCP=443\n"); err != nil {
		t.Fatalf("Apply 1: %v", err)
	}
	changed, err := m.Apply(true, "NFQWS2_PORTS_TCP=80,443\n")
	if err != nil {
		t.Fatalf("Apply 2: %v", err)
	}
	if !changed {
		t.Errorf("changed body: want changed=true")
	}
	if len(rec.calls) != 2 {
		t.Errorf("changed body: want 2 up calls, got %d", len(rec.calls))
	}
	got, _ := os.ReadFile(path)
	if string(got) != "NFQWS2_PORTS_TCP=80,443\n" {
		t.Errorf("config not rewritten: got %q", got)
	}
}

func TestApply_DisabledRunsDown(t *testing.T) {
	dir := t.TempDir()
	rec := &recorder{}
	m := New(Config{
		ConfigPath: filepath.Join(dir, "config"),
		UpCmd:      []string{"up"},
		DownCmd:    []string{"compose", "down"},
		RunCmd:     rec.run,
	}, testLogger())

	changed, err := m.Apply(false, "")
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !changed {
		t.Errorf("first disable: want changed=true")
	}
	if len(rec.calls) != 1 || rec.calls[0][0] != "compose" {
		t.Errorf("expected one down call, got %v", rec.calls)
	}
}

func TestApply_DormantWritesButSkipsExec(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config")
	rec := &recorder{}
	// ConfigPath set but UpCmd empty → zapret2 not provisioned: stage config, no exec.
	m := New(Config{ConfigPath: path, RunCmd: rec.run}, testLogger())

	changed, err := m.Apply(true, "NFQWS2_ENABLE=1\n")
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !changed {
		t.Errorf("dormant enable: want changed=true (config staged)")
	}
	if len(rec.calls) != 0 {
		t.Errorf("dormant: must not exec, got %v", rec.calls)
	}
	if _, err := os.ReadFile(path); err != nil {
		t.Errorf("dormant: config should still be written: %v", err)
	}
}
