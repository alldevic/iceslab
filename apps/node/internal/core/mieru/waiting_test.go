package mieru

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// mitaLike answers as mita 3.37.0 does (checked live 26.10): apply and reload
// take a config with no users, start refuses it with "no user found", and a
// proxy already up stays up whatever the list holds.
type mitaLike struct {
	mu      sync.Mutex
	path    string
	running bool
	calls   []string
}

func (m *mitaLike) run(_ context.Context, _ string, args ...string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cmd := strings.Join(args, " ")
	m.calls = append(m.calls, cmd)
	switch cmd {
	case "start":
		var cfg struct {
			Users []json.RawMessage `json:"users"`
		}
		b, err := os.ReadFile(m.path)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(b, &cfg); err != nil {
			return nil, err
		}
		if len(cfg.Users) == 0 {
			return []byte("start mita server proxy failed: rpc error: code = Unknown desc = no user found"), errors.New("exit status 1")
		}
		m.running = true
	case "stop":
		m.running = false
	}
	return nil, nil
}

func waitingAdapter(t *testing.T) (*Adapter, *mitaLike) {
	t.Helper()
	m := &mitaLike{path: filepath.Join(t.TempDir(), "server.json")}
	return New(Config{
		BinaryPath: "/usr/local/bin/mita",
		ConfigPath: m.path,
		Inbound:    InboundConfig{ListenPort: 2012, MTU: 1400, LoggingLevel: "INFO"},
		RunCmd:     m.run,
	}, slog.New(slog.NewTextHandler(io.Discard, nil))), m
}

var mtu1400 = []byte(`{"mtu":1400}`)

// A-275, stand 26.10: a new mieru inbound on a node nobody is on failed the
// push with mita's "no user found", three times out of three, and the push
// failing kept the roster, the first user included, off the node for good.
func TestAnInboundWithNoUsersIsHeldAndTheFirstUserStartsIt(t *testing.T) {
	a, m := waitingAdapter(t)
	if err := a.ApplyIdentifiedInbound("in-1", 27011, mtu1400); err != nil {
		t.Fatalf("an inbound with no users refused the push: %v", err)
	}
	if m.running {
		t.Fatal("mita runs a proxy with no user")
	}
	if got := a.Waiting(); got != core.NoUsersReason {
		t.Fatalf("Waiting %q, want %q", got, core.NoUsersReason)
	}
	if !a.Provisioned() {
		t.Fatal("the inbound is held, the core is configured")
	}
	for _, c := range m.calls {
		if c == "start" {
			t.Fatalf("start was asked of mita with no user: %v", m.calls)
		}
	}

	// The same push again is no work.
	n := len(m.calls)
	if err := a.ApplyIdentifiedInbound("in-1", 27011, mtu1400); err != nil {
		t.Fatal(err)
	}
	if len(m.calls) != n {
		t.Fatalf("the same push asked mita again: %v", m.calls[n:])
	}

	if err := a.AddUser(core.User{UserID: "u-1", Username: "alice", XrayUUID: "uuid-a"}); err != nil {
		t.Fatalf("the first user: %v", err)
	}
	if !m.running {
		t.Fatalf("the first user did not start mita: %v", m.calls)
	}
	if got := a.Waiting(); got != "" {
		t.Fatalf("still waiting with a user: %q", got)
	}
}

// The last user removed: mita would keep RUNNING with an empty list, holding
// its port for nobody. It goes down and waits, and the next user brings it back.
func TestTheLastUserRemovedStopsTheProxyAndTheNextOneStartsIt(t *testing.T) {
	a, m := waitingAdapter(t)
	_ = a.AddUser(core.User{UserID: "u-1", Username: "alice", XrayUUID: "uuid-a"})
	if err := a.ApplyIdentifiedInbound("in-1", 27011, mtu1400); err != nil {
		t.Fatal(err)
	}
	if !m.running {
		t.Fatalf("not running with a user: %v", m.calls)
	}
	if err := a.RemoveUser("u-1"); err != nil {
		t.Fatalf("RemoveUser: %v", err)
	}
	if m.running {
		t.Fatalf("mita runs on with no user: %v", m.calls)
	}
	if a.Waiting() == "" {
		t.Fatal("not waiting after the last user went")
	}
	if err := a.AddUser(core.User{UserID: "u-2", Username: "bob", XrayUUID: "uuid-b"}); err != nil {
		t.Fatal(err)
	}
	if !m.running {
		t.Fatalf("the next user did not start mita: %v", m.calls)
	}
}

// Idle forgets the wait with the inbounds: nothing is held, nothing waits.
func TestIdleEndsTheWait(t *testing.T) {
	a, _ := waitingAdapter(t)
	if err := a.ApplyIdentifiedInbound("in-1", 27011, mtu1400); err != nil {
		t.Fatal(err)
	}
	if err := a.Idle(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := a.Waiting(); got != "" {
		t.Fatalf("an idle core still waits: %q", got)
	}
}
