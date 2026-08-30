package singbox

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// What this adapter reports when its statsquery fails.
//
// It used to be zero-counter rows for every tracked user - the exact thing
// xray's own soft-fail comment forbids, because a cumulative counter that reads
// as zero is a counter reset to the panel. It billed nothing only because the
// helper that built them left Cumulative false, which routed them down the
// per-poll-delta path: an accident, not a guard. It stopped working the moment
// the node ran a SECOND cumulative core, which is the ordinary engine-choice
// node: with xray also reporting, the response is cumulative, the user's summed
// rows drop by sing-box's whole counter, and the panel re-baselines and bills it
// again on recovery. Measured live 2026-08-30: +516 083 bytes on a user with no
// traffic at all.
func TestFailedStatsQueryReportsNoRowsAndSaysSo(t *testing.T) {
	a := New(Config{
		XrayStatsBin: "/usr/local/bin/xray",
		StatsListen:  "127.0.0.1:8085",
		Protocol:     "hysteria",
		RunCmd: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) > 0 && args[0] == "version" {
				return []byte("sing-box version 1.13.19\nTags: with_v2ray_api\n"), nil
			}
			return []byte("failed to dial"), errors.New("exit status 1")
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	// An inbound, because a core with none is not "degraded", it is idle - the
	// distinction this adapter now makes before asking anything.
	if err := a.ApplyInbound(8443, []byte(`{}`)); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if err := a.AddUser(core.User{UserID: "u-1", Username: "alice", HysteriaPassword: "pw-a"}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if !a.Provisioned() {
		t.Fatal("the fixture is not in the state these cases are about")
	}

	st, err := a.GetStats()
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	if len(st.Users) != 0 {
		t.Errorf("a failed query still produced %d per-user row(s); a zero cumulative row "+
			"reads as a counter reset: %+v", len(st.Users), st.Users)
	}
	if !st.Degraded {
		t.Error("a failed query did not mark the poll degraded, so the panel cannot tell " +
			"this core's absence from a reset and will re-baseline the user's snapshot")
	}
}

func TestASuccessfulStatsQueryIsNotDegraded(t *testing.T) {
	// The control: Degraded hardwired to true would make every poll bill
	// nothing, which passes the case above just as well.
	a := New(Config{
		XrayStatsBin: "/usr/local/bin/xray",
		StatsListen:  "127.0.0.1:8085",
		Protocol:     "hysteria",
		RunCmd: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) > 0 && args[0] == "version" {
				return []byte("sing-box version 1.13.19\nTags: with_v2ray_api\n"), nil
			}
			return []byte(`{"stat":[{"name":"user>>>u-1>>>traffic>>>downlink","value":"516083"}]}`), nil
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	// An inbound, because a core with none is not "degraded", it is idle - the
	// distinction this adapter now makes before asking anything.
	if err := a.ApplyInbound(8443, []byte(`{}`)); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if err := a.AddUser(core.User{UserID: "u-1", Username: "alice", HysteriaPassword: "pw-a"}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if !a.Provisioned() {
		t.Fatal("the fixture is not in the state these cases are about")
	}

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
	if !st.Cumulative {
		t.Error("a non-destructive read must stay flagged cumulative")
	}
}

func TestAnAdapterWithNoInboundIsIdleNotDegraded(t *testing.T) {
	// Five of the six sing-box adapters a --with-singbox node registers never
	// receive an inbound. Their stats endpoint is nobody's, so a dial to it
	// fails every poll - and reporting THAT as degraded makes the flag
	// permanently on, which held the whole node's per-user billing when it was
	// first run on a live node. A signal that is always on carries nothing.
	dialed := false
	a := New(Config{
		XrayStatsBin: "/usr/local/bin/xray",
		StatsListen:  "127.0.0.1:8082",
		Protocol:     "tuic",
		RunCmd: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) > 0 && args[0] == "api" {
				dialed = true
				return []byte("failed to dial"), errors.New("exit status 1")
			}
			return nil, nil
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := a.AddUser(core.User{UserID: "u-1", TuicUUID: "uuid1", TuicPassword: "pw1"}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if a.Provisioned() {
		t.Fatal("the fixture was supposed to have no inbound")
	}

	st, err := a.GetStats()
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	if st.Degraded {
		t.Error("an adapter that was never given an inbound reported the poll degraded, " +
			"which stops the panel billing every user on the node")
	}
	if dialed {
		t.Error("dialled a stats endpoint for an adapter that has no inbound")
	}
	// The user is still reported, so the panel keeps its presence signal.
	if len(st.Users) != 1 {
		t.Errorf("the tracked user disappeared: %+v", st.Users)
	}
}
