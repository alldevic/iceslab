//go:build !windows

package chain

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// П-1: two Applies at once, the second while the first is still asking the
// engine. Each run of the stand-in engine leaves its pid in a directory, and
// at the end exactly one of them may be alive, the one the manager holds.
// Interleaved, both read the same old process, both started one, and the
// first was left running with nobody holding it.
func TestTwoAppliesAtOnceLeaveOneProcess(t *testing.T) {
	pids := t.TempDir()
	bin := fakeEngine(t, fmt.Sprintf("echo $$ > %s/$$; exec sleep 60", pids))
	life, stop := context.WithCancel(context.Background())
	defer stop()
	m := New(Config{
		BinaryPath: bin,
		ConfigPath: filepath.Join(t.TempDir(), "chain", "config.json"),
		Logger:     quiet(),
		Lifetime:   life,
		Run: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			switch {
			case filepath.Base(name) == "awg-quick" && len(args) > 0 && args[0] == "up":
				// Raising a leg tunnel takes time, and it sits between reading
				// the old process and putting the new one in its place: the
				// window the two Applies overlapped in.
				time.Sleep(300 * time.Millisecond)
				return nil, nil
			case filepath.Base(name) != filepath.Base(bin):
				return nil, nil // awg-quick down, ip link del
			}
			return defaultRun(ctx, name, args...)
		},
		ListLinks:  func() ([]string, error) { return nil, nil },
		LinkExists: func(string) bool { return false },
	})
	t.Cleanup(func() {
		_ = m.stop("test over")
		for _, p := range alivePids(t, pids) {
			_ = syscall.Kill(p, syscall.SIGKILL)
		}
	})

	other := strings.Replace(goldenConfig, `"warn"`, `"info"`, 1)
	var wg sync.WaitGroup
	for _, cfg := range []string{goldenConfig, other} {
		b := block(cfg)
		b.Tunnels = []dto.ChainTunnel{{Iface: "awg-l3", Conf: tunnelConfReceiving, ListenPort: 27003}}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := m.Apply(context.Background(), b); err != nil {
				t.Errorf("apply: %v", err)
			}
		}()
		time.Sleep(50 * time.Millisecond)
	}
	wg.Wait()
	time.Sleep(500 * time.Millisecond)

	alive := alivePids(t, pids)
	if len(alive) != 1 {
		t.Fatalf("%d engine processes alive after two applies, want 1: %v", len(alive), alive)
	}
	if st := m.Status(); st == nil || !st.Running {
		t.Fatalf("the one alive is not the one the manager holds: %+v", st)
	}
}

func alivePids(t *testing.T, dir string) []int {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []int
	for _, e := range entries {
		p, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if syscall.Kill(p, 0) == nil && !zombie(p) {
			out = append(out, p)
		}
	}
	return out
}

// zombie: exited and not yet reaped, which kill(0) still answers for.
func zombie(pid int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return true
	}
	s := string(b)
	i := strings.LastIndex(s, ")")
	return i < 0 || i+2 >= len(s) || s[i+2] == 'Z'
}
