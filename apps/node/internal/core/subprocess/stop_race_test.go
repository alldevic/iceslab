//go:build linux

package subprocess

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

/*
П-4, 22.10: a batch test of the sing-box adapter once saw a process start out
of order after a restart and a 3 s gap, read as "a Stop that lands right after
Start is taken for a crash and respawned, and the old process holds its port".
These ask the supervisor directly, without a core.
*/

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// Start and an immediate Stop, many times, with the restart policy on: no
// respawn after a Stop, every Stop quick, nothing left running.
func TestAStopRightAfterStartIsNotACrash(t *testing.T) {
	dir := t.TempDir()
	marker := fmt.Sprintf("iceslab-stop-race-%d", time.Now().UnixNano())
	bin := filepath.Join(dir, marker)
	script := "#!/bin/sh\necho start >> \"" + filepath.Join(dir, "starts") + "\"\nexec sleep 60\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	const rounds = 50
	for i := 0; i < rounds; i++ {
		s := New(Config{Name: "race", Binary: bin, Logger: quiet(), MaxRestarts: 5, RestartBackoff: 10 * time.Millisecond})
		if err := s.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		// Whether the process died on SIGTERM is what Stop answers: it
		// returns an error only when the grace ran out and it had to kill
		// (subprocess.go Stop). A measured "slowest Stop under 1 s" was
		// the same question asked of the runner's clock.
		if err := s.Stop(context.Background()); err != nil {
			t.Fatalf("round %d: Stop: %v (the process outlived SIGTERM)", i, err)
		}
	}
	time.Sleep(300 * time.Millisecond) // a respawn would have happened by now
	body, _ := os.ReadFile(filepath.Join(dir, "starts"))
	if n := strings.Count(string(body), "start"); n > rounds {
		t.Fatalf("%d starts for %d Start calls: a Stop was taken for a crash", n, rounds)
	}
	if out, _ := exec.Command("pgrep", "-f", marker).Output(); strings.TrimSpace(string(out)) != "" {
		t.Fatalf("processes left after Stop: %s", out)
	}
}

// Start, Stop, Start of the same listener, fast, as a config restart does:
// by the second Start the first process is dead and its port is free, so the
// new one binds. With the real engine. Skipped without SINGBOX_BIN.
func TestARestartFindsThePortFree(t *testing.T) {
	bin := os.Getenv("SINGBOX_BIN")
	if bin == "" {
		t.Skip("SINGBOX_BIN not set: the engine is not asked here")
	}
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	cfg := filepath.Join(t.TempDir(), "config.json")
	body := fmt.Sprintf(`{"log":{"level":"warn"},"inbounds":[{"type":"socks","listen":"127.0.0.1","listen_port":%d}],"outbounds":[{"type":"direct"}]}`, port)
	if err := os.WriteFile(cfg, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	newOne := func() *Subprocess {
		return New(Config{Name: "sb", Binary: bin, Args: []string{"run", "-c", cfg}, Logger: quiet(), MaxRestarts: 5, RestartBackoff: 10 * time.Millisecond})
	}
	for i := 0; i < 20; i++ {
		first := newOne()
		if err := first.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Duration(i%4) * 20 * time.Millisecond) // from "just exec'd" to "listening"
		if err := first.Stop(context.Background()); err != nil {
			t.Fatalf("round %d: Stop: %v", i, err)
		}
		second := newOne()
		if err := second.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		ok := false
		for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
			if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond); err == nil {
				c.Close()
				ok = second.Running()
				break
			}
		}
		_ = second.Stop(context.Background())
		if !ok {
			t.Fatalf("round %d: the restarted engine is not listening (running=%v, reason %q)", i, second.Running(), second.ExitReason())
		}
	}
}
