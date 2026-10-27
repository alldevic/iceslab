package xray

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

/*
A-022, 22.10: every user was put on every inbound of every node. The panel's
squad decided what a subscription showed, not what a client could use: a
credential from one squad's link worked on any other inbound of the fleet.
Now addUser names the inbounds, and the user is on those only, in the config
on disk and in the running core.
*/

const (
	scopeA = "aaaaaaaa-1111-4000-8000-000000000001"
	scopeB = "bbbbbbbb-2222-4000-8000-000000000002"
)

// clientsOn reads the rendered config: the emails on each inbound tag.
func clientsOn(t *testing.T, path string) map[string][]string {
	t.Helper()
	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Inbounds []struct {
			Tag      string `json:"tag"`
			Settings struct {
				Clients []struct {
					Email string `json:"email"`
				} `json:"clients"`
			} `json:"settings"`
		} `json:"inbounds"`
	}
	if err := json.Unmarshal(blob, &cfg); err != nil {
		t.Fatal(err)
	}
	out := map[string][]string{}
	for _, in := range cfg.Inbounds {
		for _, c := range in.Settings.Clients {
			out[in.Tag] = append(out[in.Tag], c.Email)
		}
	}
	return out
}

func TestAUserScopedToOneInboundIsOnThatOneOnly(t *testing.T) {
	c := &pickyCore{}
	a, path := pickyAdapter(t, c)
	tagA := inboundTagFor(scopeA, validInbound().Tag)
	tagB := inboundTagFor(scopeB, validInbound().Tag)
	if err := a.ApplyInbound(443, inboundWire(t, scopeA, 443)); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(8443, inboundWire(t, scopeB, 8443)); err != nil {
		t.Fatal(err)
	}
	testsBefore := c.testCount()
	alice := core.User{UserID: "alice", XrayUUID: "11111111-1111-4111-8111-111111111111"}

	// Onto A only: adu names A's tag alone, no restart.
	if err := a.AddUserOn(alice, []string{scopeA}); err != nil {
		t.Fatalf("AddUserOn A: %v", err)
	}
	on := clientsOn(t, path)
	if strings.Join(on[tagA], ",") != "alice" || len(on[tagB]) != 0 {
		t.Fatalf("on disk: %v, want alice on %s only", on, tagA)
	}

	// Moved to B: off A (rmu), onto B (adu), still no restart.
	if err := a.AddUserOn(alice, []string{scopeB}); err != nil {
		t.Fatalf("AddUserOn B: %v", err)
	}
	if len(c.rmuTags) != 1 || c.rmuTags[0] != tagA {
		t.Fatalf("rmu went to %v, want %s only", c.rmuTags, tagA)
	}
	on = clientsOn(t, path)
	if len(on[tagA]) != 0 || strings.Join(on[tagB], ",") != "alice" {
		t.Fatalf("on disk after the move: %v", on)
	}

	// Unscoped again (nil from an older panel): onto every inbound.
	if err := a.AddUser(alice); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	on = clientsOn(t, path)
	if len(on[tagA]) != 1 || len(on[tagB]) != 1 {
		t.Fatalf("an unscoped user is not on every inbound: %v", on)
	}
	if c.testCount() != testsBefore {
		t.Fatal("a scope change went down the restart path")
	}

	// Named on none of this core's inbounds: removed.
	if err := a.AddUserOn(alice, nil); err != nil {
		t.Fatal(err)
	}
	on = clientsOn(t, path)
	if len(on[tagA]) != 0 || len(on[tagB]) != 0 {
		t.Fatalf("a user scoped to nothing is still served: %v", on)
	}
}
