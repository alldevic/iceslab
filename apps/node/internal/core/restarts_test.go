package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

func TestRestartTallyCountsByCause(t *testing.T) {
	tally := NewRestartTally()
	at := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	tally.Record(subprocess.RestartEvent{Reason: subprocess.RestartReasonMemory, At: at})
	tally.Record(subprocess.RestartEvent{Reason: subprocess.RestartReasonCrash, At: at.Add(time.Minute)})
	tally.Record(subprocess.RestartEvent{Reason: subprocess.RestartReasonCrash, At: at.Add(2 * time.Minute)})
	st := tally.Stats(0, 42)
	if st.Crash != 2 || st.Memory != 1 {
		t.Fatalf("crash=%d memory=%d, want 2 and 1", st.Crash, st.Memory)
	}
	if !st.LastAt.Equal(at.Add(2*time.Minute)) || st.LastReason != string(subprocess.RestartReasonCrash) {
		t.Fatalf("last = %v %q", st.LastAt, st.LastReason)
	}
	if st.SinceAt.IsZero() || st.RSSBytes != 42 {
		t.Fatalf("since=%v rss=%d", st.SinceAt, st.RSSBytes)
	}
	var none *RestartTally
	none.Record(subprocess.RestartEvent{})
	if got := none.Stats(0, 0); got.Crash != 0 {
		t.Fatal("a nil tally counted")
	}
}

// Every adapter that runs its core as a subprocess reports its restarts. Read
// from the sources, so an adapter added later without the tally fails here
// instead of bouncing in silence on a green node.
func TestEveryProcessOwningAdapterReportsRestarts(t *testing.T) {
	dirs, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, d := range dirs {
		if !d.IsDir() || d.Name() == "subprocess" {
			continue
		}
		var src strings.Builder
		files, _ := filepath.Glob(filepath.Join(d.Name(), "*.go"))
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			b, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			src.Write(b)
		}
		code := src.String()
		if !strings.Contains(code, "subprocess.New(") {
			continue
		}
		checked++
		if !strings.Contains(code, "OnRestart:") {
			t.Errorf("%s: spawns a subprocess with no OnRestart", d.Name())
		}
		if !strings.Contains(code, "func (a *Adapter) RestartStats() core.RestartStats") {
			t.Errorf("%s: no RestartStats", d.Name())
		}
	}
	if checked < 6 {
		t.Fatalf("read %d process-owning adapters, expected at least 6", checked)
	}
}
