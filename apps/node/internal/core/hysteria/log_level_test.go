//go:build unix

package hysteria

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A-265: the hysteria the agent spawns runs with HYSTERIA_LOG_LEVEL=error. At
// info it writes the client's IP and the user's id on every connect and
// disconnect, at warn on every broken connection, and its config file has no
// key to stop it (LogLevelEnv). A stand-in
// binary writes the variable it was started with; the real core is not needed
// to see what environment the agent hands it.
func TestTheSpawnedHysteriaLogsAtError(t *testing.T) {
	dir := t.TempDir()
	seen := filepath.Join(dir, "env.txt")
	bin := filepath.Join(dir, "hysteria")
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s' \"$HYSTERIA_LOG_LEVEL\" > %s\nexec sleep 30\n", seen)
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	a := New(Config{
		BinaryPath:         bin,
		ConfigPath:         filepath.Join(dir, "config.yaml"),
		AuthCallbackPort:   freeTCP(t),
		TrafficStatsListen: fmt.Sprintf("127.0.0.1:%d", freeTCP(t)),
		TrafficStatsSecret: "fixture-stats-secret-not-a-secret",
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })

	deadline := time.Now().Add(5 * time.Second)
	var got []byte
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(seen); err == nil && len(b) > 0 {
			got = b
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if strings.TrimSpace(string(got)) != "error" {
		t.Fatalf("the spawned hysteria got HYSTERIA_LOG_LEVEL=%q, want error", got)
	}
}
