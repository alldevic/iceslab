package subprocess

import (
	"context"
	"log/slog"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"
)

// Signal is what makes a live reload live: without it, changing the user set
// means Stop+Start, which drops every connection the proxy is carrying. So it
// is worth proving the signal actually arrives, not just that the call returns
// nil.
func TestSignalReachesTheProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix signals")
	}
	// A shell that records the signal and keeps running, exactly like a core
	// that reloads rather than exits. It writes to FILES rather than stdout on
	// purpose: routing the proof through the log tap would make this a test of
	// two things, and a failure would not say which one broke.
	//
	// The `ready` file matters. Running() goes true the moment cmd.Start()
	// returns, but the shell has not installed its trap yet, and the DEFAULT
	// disposition of SIGUSR2 is terminate — signal it in that window and the
	// process simply dies. That is not a quirk of this fixture: it is true of
	// any core, and it is why the adapter signals a process it has already been
	// running rather than one it just spawned.
	dir := t.TempDir()
	ready := filepath.Join(dir, "ready")
	marker := filepath.Join(dir, "reloaded")
	script := filepath.Join(dir, "victim.sh")
	body := "#!/bin/sh\n" +
		"trap 'echo yes > " + marker + "' USR2\n" +
		"echo yes > " + ready + "\n" +
		"while :; do sleep 0.05; done\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}

	s := New(Config{
		Name:   "victim",
		Binary: "/bin/sh",
		Args:   []string{script},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer s.Stop(context.Background())

	exists := func(p string) func() bool {
		return func() bool { _, err := os.Stat(p); return err == nil }
	}
	if !waitFor(t, 3*time.Second, exists(ready)) {
		t.Fatal("the process never reached the point where its trap is installed")
	}

	if err := s.Signal(syscall.SIGUSR2); err != nil {
		t.Fatalf("Signal: %v", err)
	}
	if !waitFor(t, 3*time.Second, exists(marker)) {
		t.Fatal("the process never handled the signal")
	}

	// And it is still alive: a reload must not be a restart.
	if !s.Running() {
		t.Error("the process died on SIGUSR2; a reload signal must not kill the core")
	}
}

func TestSignalOnStoppedProcessIsNotAnError(t *testing.T) {
	// A reload signal to a core that is not running is not a failure: the
	// config it would re-read is already on disk and gets read when it starts.
	// Returning an error here would make a routine push look broken on a node
	// whose core is between restarts.
	s := New(Config{Name: "never-started", Binary: "/bin/true"})
	if err := s.Signal(syscall.SIGUSR2); err != nil {
		t.Errorf("Signal on a never-started process = %v, want nil", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s2 := New(Config{
		Name:   "shortlived",
		Binary: "/bin/true",
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err := s2.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 2*time.Second, func() bool { return !s2.Running() }) {
		t.Fatal("process never exited")
	}
	if err := s2.Signal(syscall.SIGUSR2); err != nil {
		t.Errorf("Signal on an exited process = %v, want nil", err)
	}
}
