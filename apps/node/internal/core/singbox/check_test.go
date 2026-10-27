package singbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A-110, 22.10: the config went over the running one without asking the
// engine. A config `sing-box check` refuses now leaves the running process,
// the file on disk and the held inbounds as they were.
func TestAConfigTheEngineRefusesReplacesNothing(t *testing.T) {
	a, starts := countingAdapter(t) // already running on 9443, its start seen
	cfgPath := filepath.Join(filepath.Dir(starts), "config.json")
	before, _ := os.ReadFile(cfgPath)
	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	base := startCount(starts)

	err := a.ApplyIdentifiedInbound("second", 9444, []byte(`{"serverName":"refuse-me"}`))
	if err == nil || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("expected the engine's refusal, got %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	after, _ := os.ReadFile(cfgPath)
	a.mu.Lock()
	same := a.proc == proc
	_, held := a.inbounds["second"]
	a.mu.Unlock()
	if !same || startCount(starts) != base {
		t.Fatal("a refused config restarted the process")
	}
	if string(after) != string(before) {
		t.Fatal("a refused config replaced the file on disk")
	}
	if held {
		t.Fatal("the refused inbound stayed held: every later render would carry it")
	}
}
