//go:build unix

package subprocess

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A core told to re-read its config gets the signal and keeps running: no
// restart, so the connections it carries stay up.
func TestSignalReachesTheRunningProcess(t *testing.T) {
	mark := filepath.Join(t.TempDir(), "got")
	p := New(Config{
		Name:   "signal-test",
		Binary: "/bin/sh",
		Args:   []string{"-c", "trap 'echo usr2 >> " + mark + "' USR2; while :; do sleep 0.05; done"},
		Logger: newSilentLogger(),
	})
	if err := p.Signal(syscall.SIGUSR2); err == nil {
		t.Fatal("Signal before Start reported success")
	}
	if err := p.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = p.Stop(context.Background()) }()
	time.Sleep(200 * time.Millisecond) // let the trap be installed

	if err := p.Signal(syscall.SIGUSR2); err != nil {
		t.Fatalf("Signal: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		b, _ := os.ReadFile(mark)
		if strings.Contains(string(b), "usr2") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the process never saw the signal")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !p.Running() {
		t.Fatal("the signal stopped the process")
	}

	_ = p.Stop(context.Background())
	if err := p.Signal(syscall.SIGUSR2); err == nil {
		t.Fatal("Signal after Stop reported success")
	}
}
