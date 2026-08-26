package singbox

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// Stop is what the agent calls on shutdown and on a protocol being switched
// off, and its visible effect is Healthy going false. That matters more than it
// reads: Healthy feeds /healthz, /healthz feeds the node's status, and the
// status decides whether the node goes into subscriptions at all. An adapter
// still reporting healthy after Stop is a green node serving a protocol that
// is not running — the shape this fork keeps finding.
//
// No binary needed: with BinaryPath empty the adapter never spawns, so Healthy
// is exactly the started flag Stop is responsible for clearing.
func TestStop_TurnsTheAdapterUnhealthyAndIsIdempotent(t *testing.T) {
	a := testAdapter()
	if err := a.AddUser(core.User{UserID: "u1", TuicUUID: "uuid1", TuicPassword: "pw1"}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !a.Healthy() {
		t.Fatal("Healthy false after Start; the rest of this test would prove nothing")
	}

	if err := a.Stop(context.Background()); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if a.Healthy() {
		t.Error("Healthy still true after Stop: the panel would keep this node in subscriptions")
	}

	// The agent's shutdown path can reach Stop after a crash already cleared
	// the process, and stopAdapters calls it for every adapter regardless.
	if err := a.Stop(context.Background()); err != nil {
		t.Errorf("second Stop: %v", err)
	}
	if a.Healthy() {
		t.Error("Healthy true again after a second Stop")
	}
}

// Users survive a stop/start cycle: they live in the adapter's map, not in the
// process. Losing them here would silently deauthorise everyone on the next
// restart, with no error anywhere.
func TestStop_KeepsTheUserSet(t *testing.T) {
	a := testAdapter()
	_ = a.AddUser(core.User{UserID: "u1", TuicUUID: "uuid1", TuicPassword: "pw1"})
	_ = a.Start(context.Background())
	_ = a.Stop(context.Background())

	stats, err := a.GetStats()
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	if len(stats.Users) != 1 || stats.Users[0].UserID != "u1" {
		t.Fatalf("users after Stop: %+v", stats.Users)
	}

	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("restart: %v", err)
	}
	if !a.Healthy() {
		t.Error("Healthy false after a restart")
	}
	if err := a.ApplyInbound(8443, json.RawMessage(`{}`)); err != nil {
		t.Errorf("ApplyInbound after a restart: %v", err)
	}
}
