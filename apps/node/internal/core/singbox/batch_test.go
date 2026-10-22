package singbox

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A-119, 22.10. The timings are scaled down from the real 2 s / 10 s (quiet
// 40 ms, cap 200 ms); the rule they test is the same.

type flushLog struct {
	mu    sync.Mutex
	times []time.Time
}

func (f *flushLog) add() {
	f.mu.Lock()
	f.times = append(f.times, time.Now())
	f.mu.Unlock()
}

func (f *flushLog) all() []time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]time.Time(nil), f.times...)
}

// countingAdapter runs a stub sing-box that writes a line on every start
// beside its config, and records every batch's restart decision.
func countingAdapter(t *testing.T) (*Adapter, string, *flushLog) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "sing-box-stub")
	// `version` answers at once (the adapter asks it for its build tags).
	script := "#!/bin/sh\nif [ \"$1\" = version ]; then echo 'sing-box version 1.13.14'; exit 0; fi\n" +
		"echo start >> \"$(dirname \"$3\")/starts\"\nexec sleep 60\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	a := New(Config{
		Protocol:    "tuic",
		BinaryPath:  bin,
		ConfigPath:  filepath.Join(dir, "config.json"),
		QuietWindow: 40 * time.Millisecond,
		MaxWait:     200 * time.Millisecond,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	log := &flushLog{}
	a.onFlush = log.add
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	if err := a.ApplyInbound(9443, []byte(`{"serverName":"n.example.test"}`)); err != nil {
		t.Fatal(err)
	}
	return a, filepath.Join(dir, "starts"), log
}

func startCount(path string) int {
	body, _ := os.ReadFile(path)
	return strings.Count(string(body), "start")
}

func user(i int) core.User {
	return core.User{UserID: fmt.Sprintf("u-%d", i), TuicUUID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i), TuicPassword: "p"}
}

// 1000 users added in a row: one restart after the push's own, not 1000.
func TestAThousandAddsAreOneRestart(t *testing.T) {
	a, path, log := countingAdapter(t)
	time.Sleep(100 * time.Millisecond)
	base := startCount(path)
	for i := 0; i < 1000; i++ {
		if err := a.AddUser(user(i)); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(600 * time.Millisecond)
	if got := len(log.all()); got != 1 {
		t.Fatalf("%d restart decisions for 1000 adds, want 1", got)
	}
	if got := startCount(path) - base; got != 1 {
		t.Fatalf("%d process starts for 1000 adds, want 1", got)
	}
	blob, _ := os.ReadFile(filepath.Join(filepath.Dir(path), "config.json"))
	if !strings.Contains(string(blob), "00000000-0000-4000-8000-000000000999") {
		t.Fatal("the last user of the batch is not in the config")
	}
}

// A batch that fires while the adapter is being stopped: the Stop lands after
// the batch has decided to restart and before it renders. The adapter is
// stopped, so no process may come up after it (AUDT, 22.10: Stop did not take
// restartMu and the render did not look at started).
func TestAStopDuringABatchLeavesNoProcess(t *testing.T) {
	a, path, _ := countingAdapter(t)
	time.Sleep(100 * time.Millisecond)
	stopped := make(chan struct{})
	a.mu.Lock()
	a.onFlush = func() {
		_ = a.Stop(context.Background())
		close(stopped)
	}
	a.mu.Unlock()
	base := startCount(path)
	if err := a.AddUser(user(1)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("the batch never fired")
	}
	time.Sleep(300 * time.Millisecond)
	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if proc != nil || startCount(path) != base {
		t.Fatalf("a process came up after Stop: proc=%v starts +%d", proc != nil, startCount(path)-base)
	}
}

// A steady stream of changes, every 10 ms against a 40 ms quiet window, for
// six caps: the cap holds. Restarts are decided about once per cap, never put
// off forever.
func TestASteadyStreamStillRestartsWithinTheCap(t *testing.T) {
	a, _, log := countingAdapter(t)
	begin := time.Now()
	for i := 0; time.Since(begin) < 1200*time.Millisecond; i++ {
		_ = a.AddUser(user(i))
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)
	all := log.all()
	if len(all) < 5 {
		t.Fatalf("%d restarts over 1.2 s of steady changes with a 200 ms cap, want at least 5", len(all))
	}
	var gaps []time.Duration
	prev := begin
	for _, s := range all {
		gaps = append(gaps, s.Sub(prev).Round(time.Millisecond))
		prev = s
	}
	for _, gap := range gaps {
		// The cap plus the restart that ran before this batch began counting.
		if gap > 300*time.Millisecond {
			t.Fatalf("gaps between restart decisions %v, the cap is 200 ms", gaps)
		}
	}
}
