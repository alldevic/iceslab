package naive

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func caddyRuns(t *testing.T, starts string) int {
	t.Helper()
	b, err := os.ReadFile(starts)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return strings.Count(string(b), "run\n")
}

// A caddy that died after it had passed the startup window is not "unchanged":
// the same push starts it again (a reload cannot, there is no admin socket),
// and so does a push after a cold start that never took.
func TestApplyInbound_UnchangedPushWithACaddyThatDiedLateStartsItAgain(t *testing.T) {
	dir := t.TempDir()
	starts := filepath.Join(dir, "starts")
	bin := filepath.Join(dir, "caddy")
	script := "#!/bin/sh\n[ \"$1\" = run ] || exit 0\necho run >> '" + starts + "'\nexec sleep 30\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	a := New(Config{
		Inbound:       validInbound(),
		CaddyfilePath: filepath.Join(dir, "Caddyfile"),
		CaddyBin:      bin,
		AdminSocket:   filepath.Join(dir, "admin", "caddy.sock"),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := caddyRuns(t, starts); n != 1 {
		t.Fatalf("Start ran caddy %d times, want 1", n)
	}

	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if err := proc.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a.Healthy() {
		t.Fatal("setup: the core still reports healthy")
	}

	wire := wirePayload(t, func(m map[string]any) {
		m["hostname"] = "n1.example.com"
		m["tlsEmail"] = "ops@example.com"
		m["masqueradeRoot"] = ""
	})
	if err := a.ApplyInbound(443, wire); err != nil {
		t.Fatal(err)
	}
	if n := caddyRuns(t, starts); n != 2 {
		t.Fatalf("an unchanged push left the dead caddy dead: %d runs, want 2", n)
	}
	if !a.Healthy() {
		t.Error("the restarted core does not report healthy")
	}
	if err := a.ApplyInbound(443, wire); err != nil {
		t.Fatal(err)
	}
	if n := caddyRuns(t, starts); n != 2 {
		t.Errorf("an unchanged push with a live caddy ran it again: %d runs", n)
	}
}
