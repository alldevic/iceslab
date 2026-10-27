package mieru

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
)

// mita's unit runs an RPC server that takes `apply config` and `reload` with
// rc=0 while its proxy is IDLE and listening on nothing. So health and "the
// config did not change" are asked of `mita status`, not of the adapter's
// own record of commands that cannot fail.
type statusRunner struct {
	mu     sync.Mutex
	status string
	calls  []string
}

func (r *statusRunner) run(_ context.Context, _ string, args ...string) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, strings.Join(args, " "))
	if len(args) > 0 && args[0] == "status" {
		return []byte(r.status), nil
	}
	return nil, nil
}

func (r *statusRunner) set(s string) {
	r.mu.Lock()
	r.status = s
	r.calls = nil
	r.mu.Unlock()
}

func (r *statusRunner) ran(sub string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range r.calls {
		if strings.HasPrefix(c, sub) {
			return true
		}
	}
	return false
}

func servingAdapter(t *testing.T) (*Adapter, *statusRunner) {
	t.Helper()
	r := &statusRunner{status: `mita server status is "RUNNING"`}
	a := New(Config{
		BinaryPath: "/usr/local/bin/mita",
		ConfigPath: t.TempDir() + "/server.json",
		Inbound:    InboundConfig{ListenPort: 2012, MTU: 1400, LoggingLevel: "INFO"},
		RunCmd:     r.run,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	withUser(t, a)
	body, _ := json.Marshal(map[string]any{"mtu": 1400})
	if err := a.ApplyInbound(2012, body); err != nil {
		t.Fatal(err)
	}
	return a, r
}

func TestHealthyIsWhatMitaSays(t *testing.T) {
	a, r := servingAdapter(t)
	if !a.Healthy() {
		t.Fatal("mita says RUNNING and the adapter says not healthy")
	}
	r.set(`mita server status is "IDLE"`)
	a.invalidateStatus()
	if a.Healthy() {
		t.Fatal("mita's proxy is IDLE and the adapter reports healthy")
	}
}

func TestAnUnchangedPushStartsAProxyThatStopped(t *testing.T) {
	a, r := servingAdapter(t)
	body, _ := json.Marshal(map[string]any{"mtu": 1400})

	// Serving, same bytes: nothing to do.
	r.set(`mita server status is "RUNNING"`)
	a.invalidateStatus()
	if err := a.ApplyInbound(2012, body); err != nil {
		t.Fatal(err)
	}
	if r.ran("start") || r.ran("apply") {
		t.Fatalf("a no-op resync ran the CLI: %v", r.calls)
	}

	// Stopped out of band: the same bytes must not keep it down.
	r.set(`mita server status is "IDLE"`)
	a.invalidateStatus()
	if err := a.ApplyInbound(2012, body); err != nil {
		t.Fatal(err)
	}
	if !r.ran("start") {
		t.Fatalf("mita is IDLE and an unchanged push did not start it: %v", r.calls)
	}
}
