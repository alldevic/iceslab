package xray

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A-130, 22.10: an inbound `xray -test` refused stayed in the adapter's map.
// The running core never had its tag, so every later adu came back short of
// "Added N", every rmu stopped on that tag, both fell into a restart that -test
// refused again, and the live path wrote the refused config to disk on the way.

// pickyCore stands in for xray: `-test` refuses any candidate carrying
// `refuse`, an accepted candidate becomes what the core runs, and adu/rmu
// answer only for tags the running config has, the way the real HandlerService
// does.
type pickyCore struct {
	mu      sync.Mutex
	refuse  string
	running map[string]bool
	tests   int
	adu     int
	rmuTags []string
}

func (c *pickyCore) run(_ context.Context, _ string, args ...string) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case len(args) >= 3 && args[0] == "-test":
		c.tests++
		blob, err := os.ReadFile(args[2])
		if err != nil {
			return nil, err
		}
		if c.refuse != "" && strings.Contains(string(blob), c.refuse) {
			return []byte("Failed to start: main: failed to load config files > tls: failed to find any PEM data"),
				errors.New("exit status 23")
		}
		c.running = tagsIn(blob)
		return []byte("Configuration OK."), nil
	case len(args) >= 4 && args[0] == "api" && args[1] == "adu":
		c.adu++
		blob, err := os.ReadFile(args[len(args)-1])
		if err != nil {
			return nil, err
		}
		n := 0
		for tag := range tagsIn(blob) {
			if c.running[tag] {
				n++
			}
		}
		return []byte(fmt.Sprintf("Added %d user(s) in total.", n)), nil
	case len(args) >= 5 && args[0] == "api" && args[1] == "rmu":
		tag := strings.TrimPrefix(args[3], "-tag=")
		c.rmuTags = append(c.rmuTags, tag)
		if !c.running[tag] {
			return []byte("failed to get handler: " + tag + "\nRemoved 0 user(s) in total."), nil
		}
		return []byte("Removed 1 user(s) in total."), nil
	}
	return nil, fmt.Errorf("unexpected call %v", args)
}

func (c *pickyCore) testCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.tests
}

func tagsIn(blob []byte) map[string]bool {
	var cfg struct {
		Inbounds []struct {
			Tag string `json:"tag"`
		} `json:"inbounds"`
	}
	_ = json.Unmarshal(blob, &cfg)
	out := make(map[string]bool, len(cfg.Inbounds))
	for _, in := range cfg.Inbounds {
		out[in.Tag] = true
	}
	return out
}

func pickyAdapter(t *testing.T, c *pickyCore) (*Adapter, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	a := New(Config{
		ConfigPath: path,
		BinaryPath: stubBinary(t, dir),
		RunCmd:     c.run,
		Inbound:    validInbound(),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	return a, path
}

func TestRefusedInboundLeavesUsersLiveOnTheOthers(t *testing.T) {
	const idA = "aaaaaaaa-1111-4000-8000-000000000001"
	const idB = "bbbbbbbb-2222-4000-8000-000000000002"
	tagA := inboundTagFor(idA, validInbound().Tag)
	tagB := inboundTagFor(idB, validInbound().Tag)

	c := &pickyCore{}
	a, path := pickyAdapter(t, c)
	if err := a.ApplyInbound(443, inboundWire(t, idA, 443)); err != nil {
		t.Fatalf("ApplyInbound A: %v", err)
	}

	c.mu.Lock()
	c.refuse = tagB
	c.mu.Unlock()
	if err := a.ApplyInbound(8443, inboundWire(t, idB, 8443)); err == nil {
		t.Fatal("expected ApplyInbound B to fail when the core refuses it")
	}
	a.mu.Lock()
	_, heldB := a.inbounds[idB]
	a.mu.Unlock()
	if heldB {
		t.Fatal("the refused inbound stayed in the adapter's map")
	}

	testsBefore := c.testCount()

	if err := a.AddUser(core.User{UserID: "alice", XrayUUID: "11111111-1111-4111-8111-111111111111"}); err != nil {
		t.Fatalf("AddUser after a refused inbound: %v", err)
	}
	if c.adu != 1 {
		t.Fatalf("adu ran %d times, want 1", c.adu)
	}
	// A restart would have asked -test again; the live add needs no restart.
	if got := c.testCount(); got != testsBefore {
		t.Fatalf("AddUser went down the restart path (%d -test runs after the refusal)", got-testsBefore)
	}
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if strings.Contains(string(onDisk), tagB) {
		t.Fatal("the live path wrote the refused inbound to disk")
	}
	if !strings.Contains(string(onDisk), "alice") {
		t.Fatal("the live add did not reach the config on disk")
	}

	if err := a.RemoveUser("alice"); err != nil {
		t.Fatalf("RemoveUser after a refused inbound: %v", err)
	}
	if len(c.rmuTags) != 1 || c.rmuTags[0] != tagA {
		t.Fatalf("rmu went to %v, want only %s", c.rmuTags, tagA)
	}
	if got := c.testCount(); got != testsBefore {
		t.Fatalf("RemoveUser went down the restart path (%d -test runs after the refusal)", got-testsBefore)
	}
	onDisk, err = os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if strings.Contains(string(onDisk), "alice") {
		t.Fatal("the live remove did not reach the config on disk")
	}
}

// A refused CHANGE to an inbound the core already serves puts the served
// version back, not nothing: the core still runs it, and its users with it.
func TestRefusedChangeKeepsTheServedVersion(t *testing.T) {
	const idA = "aaaaaaaa-1111-4000-8000-000000000001"
	c := &pickyCore{}
	a, _ := pickyAdapter(t, c)
	if err := a.ApplyInbound(443, inboundWire(t, idA, 443)); err != nil {
		t.Fatalf("ApplyInbound A: %v", err)
	}
	a.mu.Lock()
	served := a.inbounds[idA]
	a.mu.Unlock()

	c.mu.Lock()
	c.refuse = `"port": 9443`
	c.mu.Unlock()
	if err := a.ApplyInbound(9443, inboundWire(t, idA, 9443)); err == nil {
		t.Fatal("expected the changed inbound to be refused")
	}
	a.mu.Lock()
	held, ok := a.inbounds[idA]
	a.mu.Unlock()
	if !ok || !inboundEqual(held, served) {
		t.Fatalf("after a refused change the adapter holds %+v, want the served %+v", held, served)
	}
}

// The other side of the rule: -test accepted, the config went to disk, and the
// process would not start. Memory keeps the new inbound because the disk has it,
// and the failure is not swallowed: the push answers with it, and the core
// reports not running while it stays provisioned, which is what the panel reads
// as "configured and down" (P1).
func TestACoreThatWillNotStartAfterTheWriteIsReported(t *testing.T) {
	const idA = "aaaaaaaa-1111-4000-8000-000000000001"
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	// Not executable: exec fails at spawn, after validation and the write.
	bin := filepath.Join(dir, "xray-not-executable")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nsleep 60\n"), 0o644); err != nil {
		t.Fatalf("write binary: %v", err)
	}
	c := &pickyCore{}
	a := New(Config{
		ConfigPath: path,
		BinaryPath: bin,
		RunCmd:     c.run,
		Inbound:    validInbound(),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { _ = a.Stop(context.Background()) })

	err := a.ApplyInbound(443, inboundWire(t, idA, 443))
	if err == nil || !strings.Contains(err.Error(), "start xray") {
		t.Fatalf("the push must answer with the start failure, got: %v", err)
	}
	if isRefused(err) {
		t.Fatal("a start failure after the write must not read as a refusal")
	}
	onDisk, rerr := os.ReadFile(path)
	if rerr != nil {
		t.Fatalf("read config: %v", rerr)
	}
	tagA := inboundTagFor(idA, validInbound().Tag)
	if !strings.Contains(string(onDisk), tagA) {
		t.Fatal("expected the accepted config on disk")
	}
	a.mu.Lock()
	_, held := a.inbounds[idA]
	a.mu.Unlock()
	if !held {
		t.Fatal("memory dropped an inbound the disk has")
	}
	if a.Healthy() {
		t.Fatal("a core whose process did not start reports healthy")
	}
	if !a.Provisioned() {
		t.Fatal("a configured core that is down must stay provisioned, or it reads as never configured")
	}
}

// The node-level blocks go the same way: a resolver the core refused is not
// the one the next render starts from.
func TestRefusedDnsIsNotKept(t *testing.T) {
	c := &pickyCore{}
	a, _ := pickyAdapter(t, c)
	if err := a.ApplyInbound(443, inboundWire(t, "aaaaaaaa-1111-4000-8000-000000000001", 443)); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	c.mu.Lock()
	c.refuse = "203.0.113.53"
	c.mu.Unlock()
	if err := a.ApplyDns(json.RawMessage(`{"servers":[{"address":"203.0.113.53"}]}`)); err == nil {
		t.Fatal("expected the resolver to be refused")
	}
	a.mu.Lock()
	dns := a.dns
	a.mu.Unlock()
	if dns != nil {
		t.Fatalf("the refused resolver stayed: %+v", dns)
	}
}
