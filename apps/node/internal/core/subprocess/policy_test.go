package subprocess

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// One crash-restart policy for every core, as in v0.3.1: DefaultMaxRestarts
// inside restartResetWindow, then the supervisor leaves the core down. No
// adapter keeps a core up forever, and none picks its own numbers (17.6 saw
// xray and shadowsocks respawn after 0.15 s through nine kills; the only
// 100 ms restarter on such a node is upstream's xray unit, not this
// supervisor, see bootstrap-xray.sh). The test reads the adapters' sources
// because the numbers are set where each spawns its core.
func TestEveryCoreSpawnsUnderTheSharedRestartPolicy(t *testing.T) {
	spawners := []string{
		"../xray/adapter.go",
		"../shadowsocks/adapter.go",
		"../singbox/adapter.go",
		"../hysteria/adapter.go",
		"../naive/adapter.go",
		"../mtproto/adapter.go",
		"../mtprotoproxy/adapter.go",
		"../../chain/chain.go",
	}
	maxRe := regexp.MustCompile(`MaxRestarts:\s*(\S+?),`)
	backRe := regexp.MustCompile(`RestartBackoff:\s*(\S+?),`)
	for _, rel := range spawners {
		src, err := os.ReadFile(filepath.FromSlash(rel))
		if err != nil {
			t.Fatalf("%s: %v", rel, err)
		}
		text := string(src)
		if n := strings.Count(text, "subprocess.Config{"); n != 1 {
			t.Errorf("%s builds %d subprocess configs, the policy test expects one", rel, n)
		}
		if m := maxRe.FindAllStringSubmatch(text, -1); len(m) != 1 || m[0][1] != "subprocess.DefaultMaxRestarts" {
			t.Errorf("%s does not take MaxRestarts from subprocess.DefaultMaxRestarts: %v", rel, m)
		}
		if m := backRe.FindAllStringSubmatch(text, -1); len(m) != 1 || m[0][1] != "subprocess.DefaultRestartBackoff" {
			t.Errorf("%s does not take RestartBackoff from subprocess.DefaultRestartBackoff: %v", rel, m)
		}
	}
	if DefaultMaxRestarts != 5 || DefaultRestartBackoff.Seconds() != 2 || restartResetWindow.Seconds() != 60 {
		t.Errorf("the shared policy moved off v0.3.1 (5 restarts, 2 s, 60 s): %d, %v, %v",
			DefaultMaxRestarts, DefaultRestartBackoff, restartResetWindow)
	}
}
