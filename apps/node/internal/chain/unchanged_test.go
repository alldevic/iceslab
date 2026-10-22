package chain

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A-106, 22.10: every push restarted the chain process, and most pushes are
// not about the chain. A push that repeats the running block leaves the
// process alone; a changed block, or a process that died, restarts it.
func TestTheSameChainBlockDoesNotRestartTheProcess(t *testing.T) {
	dir := t.TempDir()
	starts := filepath.Join(dir, "starts")
	bin := fakeEngine(t, "echo start >> "+starts+"; exec sleep 60")
	m := New(Config{BinaryPath: bin, ConfigPath: filepath.Join(dir, "chain", "config.json"), Logger: quiet()})
	defer func() { _ = m.stop("test over") }()

	count := func() int {
		time.Sleep(150 * time.Millisecond)
		body, _ := os.ReadFile(starts)
		return strings.Count(string(body), "start")
	}

	if err := m.Apply(context.Background(), block(goldenConfig)); err != nil {
		t.Fatal(err)
	}
	if n := count(); n != 1 {
		t.Fatalf("%d starts after the first push", n)
	}
	m.mu.Lock()
	first := m.proc
	m.mu.Unlock()

	// The same block again, re-indented the way JSON from the panel may be.
	again := block("  " + goldenConfig + "\n")
	if err := m.Apply(context.Background(), again); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	same := m.proc == first
	m.mu.Unlock()
	if n := count(); n != 1 || !same {
		t.Fatalf("a repeated block restarted the chain: %d starts, same process %v", n, same)
	}

	// A changed block restarts it.
	changed := block(goldenConfig)
	changed.SocksPassword = "another-password-0000000000000000"
	if err := m.Apply(context.Background(), changed); err != nil {
		t.Fatal(err)
	}
	if n := count(); n != 2 {
		t.Fatalf("a changed block did not restart the chain: %d starts", n)
	}

	// A process that died comes back on the same block.
	m.mu.Lock()
	p := m.proc
	m.mu.Unlock()
	_ = p.Stop(context.Background())
	if err := m.Apply(context.Background(), changed); err != nil {
		t.Fatal(err)
	}
	if n := count(); n != 3 {
		t.Fatalf("a dead chain was not started again by the same block: %d starts", n)
	}
}
