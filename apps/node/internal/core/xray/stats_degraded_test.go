package xray

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// xray already emits NO per-user rows when its statsquery fails, and its own
// comment says why: zero-counter rows would read as a cumulative drop to zero
// and re-baseline the panel's snapshots.
//
// That is necessary and not sufficient. The panel sums a user's cumulative rows
// ACROSS cores before comparing them to the snapshot, so on a node that also
// runs sing-box for the same user "xray said nothing" and "xray said zero" come
// out identical: the sum falls by xray's whole counter either way, and the next
// successful poll bills the difference. Measured live 2026-08-30 in the other
// direction (sing-box blocked for one poll, +516 083 bytes on a user with no
// traffic). Only the node can tell the two apart, so it reports Degraded.
func TestAFailedUserStatsQueryIsReportedAsDegraded(t *testing.T) {
	dir := t.TempDir()
	a := New(Config{
		ConfigPath: filepath.Join(dir, "config.json"),
		BinaryPath: stubBinary(t, dir),
		Inbound:    validInbound(),
		RunCmd: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) > 1 && args[0] == "api" && args[1] == "statsquery" {
				return []byte("failed to dial"), errors.New("exit status 1")
			}
			return nil, nil
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := a.AddUser(core.User{
		UserID: "alice", XrayUUID: "00000000-0000-0000-0000-000000000001",
	}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	// Force the "core is up" branch so the query is actually attempted.
	a.mu.Lock()
	a.started = true
	a.mu.Unlock()

	st, err := a.GetStats()
	if err != nil {
		t.Fatalf("GetStats must degrade quietly, got %v", err)
	}
	if len(st.Users) != 0 {
		t.Errorf("a failed query still emitted %d per-user row(s): %+v", len(st.Users), st.Users)
	}
	if !st.Degraded {
		t.Error("a failed statsquery did not mark the poll degraded, so a node whose users " +
			"are also served by sing-box will re-baseline their snapshots to the other core alone")
	}
}

func TestASuccessfulUserStatsQueryIsNotDegraded(t *testing.T) {
	// The control: Degraded hardwired to true would hold every poll's bytes.
	dir := t.TempDir()
	a := New(Config{
		ConfigPath: filepath.Join(dir, "config.json"),
		BinaryPath: stubBinary(t, dir),
		Inbound:    validInbound(),
		RunCmd: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) > 1 && args[0] == "api" && args[1] == "statsquery" {
				joined := strings.Join(args, " ")
				if strings.Contains(joined, "user") {
					return []byte(`{"stat":[{"name":"user>>>alice>>>traffic>>>downlink","value":"516083"}]}`), nil
				}
				return []byte(`{"stat":[]}`), nil
			}
			return nil, nil
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := a.AddUser(core.User{
		UserID: "alice", XrayUUID: "00000000-0000-0000-0000-000000000001",
	}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	a.mu.Lock()
	a.started = true
	a.mu.Unlock()

	st, err := a.GetStats()
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	if st.Degraded {
		t.Error("a successful query was reported as degraded")
	}
	if len(st.Users) != 1 || st.Users[0].BytesOut != 516083 {
		t.Errorf("the counters did not come through: %+v", st.Users)
	}
}
