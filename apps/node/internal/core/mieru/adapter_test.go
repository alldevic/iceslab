package mieru

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

type recordingRunner struct {
	mu    sync.Mutex
	calls [][]string
}

func (r *recordingRunner) run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, append([]string{name}, args...))
	return nil, nil
}

func newConfigOnlyAdapter(t *testing.T) *Adapter {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(Config{
		Inbound: InboundConfig{ListenPort: 2012, MTU: 1400, LoggingLevel: "INFO"},
	}, logger)
}

func TestNameMatchesProtocol(t *testing.T) {
	a := newConfigOnlyAdapter(t)
	if a.Name() != Name {
		t.Errorf("Name: got %q want %q", a.Name(), Name)
	}
}

func TestAddUser(t *testing.T) {
	a := newConfigOnlyAdapter(t)
	if err := a.AddUser(core.User{
		UserID:   "u-1",
		Username: "alice",
		XrayUUID: "uuid-a",
	}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	u := a.users["u-1"]
	if u.Name != "alice" || u.Password != "uuid-a" {
		t.Errorf("user mapping: got %+v", u)
	}
}

func TestAddUserSkipsWithoutUUID(t *testing.T) {
	a := newConfigOnlyAdapter(t)
	if err := a.AddUser(core.User{UserID: "u-1", Username: "alice"}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if len(a.users) != 0 {
		t.Errorf("user without XrayUUID should not be tracked")
	}
}

func TestAddUserSkipsWithoutUsername(t *testing.T) {
	a := newConfigOnlyAdapter(t)
	if err := a.AddUser(core.User{UserID: "u-1", XrayUUID: "uuid-a"}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if len(a.users) != 0 {
		t.Errorf("user without Username should not be tracked (mieru needs name+password)")
	}
}

func TestAddUserIsIdempotent(t *testing.T) {
	a := newConfigOnlyAdapter(t)
	user := core.User{UserID: "u-1", Username: "alice", XrayUUID: "uuid-a"}
	_ = a.AddUser(user)
	_ = a.AddUser(user)
	_ = a.AddUser(user)
	if len(a.users) != 1 {
		t.Errorf("expected 1 user after 3x AddUser, got %d", len(a.users))
	}
}

func TestRemoveUser(t *testing.T) {
	a := newConfigOnlyAdapter(t)
	_ = a.AddUser(core.User{UserID: "u-1", Username: "alice", XrayUUID: "uuid-a"})
	if err := a.RemoveUser("u-1"); err != nil {
		t.Fatalf("RemoveUser: %v", err)
	}
	if len(a.users) != 0 {
		t.Errorf("user not removed")
	}
}

func TestApplyInbound_MTUChange(t *testing.T) {
	a := newConfigOnlyAdapter(t)
	body, _ := json.Marshal(map[string]any{"mtu": 1280})
	if err := a.ApplyInbound(443, body); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if a.inbounds[""].MTU != 1280 {
		t.Errorf("MTU not updated: got %d", a.inbounds[""].MTU)
	}
}

// Wave-14 C1 regression: panel-pushed port change updates ListenPort so
// portBindings in the next render carry the new port.
func TestApplyInbound_PortChangeRegenerates(t *testing.T) {
	a := newConfigOnlyAdapter(t)
	body, _ := json.Marshal(map[string]any{"mtu": 1400})
	if err := a.ApplyInbound(9012, body); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if a.inbounds[""].ListenPort != 9012 {
		t.Errorf("port not updated, got %d want 9012", a.inbounds[""].ListenPort)
	}
}

func TestApplyInbound_RejectsMalformedJSON(t *testing.T) {
	a := newConfigOnlyAdapter(t)
	if err := a.ApplyInbound(443, []byte("{not json")); err == nil {
		t.Errorf("expected parse error")
	}
}

func managedAdapter(t *testing.T, runner *recordingRunner) (*Adapter, string) {
	t.Helper()
	path := t.TempDir() + "/server.json"
	return New(Config{
		BinaryPath: "/usr/local/bin/mita",
		ConfigPath: path,
		Inbound:    InboundConfig{ListenPort: 2012, MTU: 1400, LoggingLevel: "INFO"},
		RunCmd:     runner.run,
	}, slog.New(slog.NewTextHandler(io.Discard, nil))), path
}

func (r *recordingRunner) joined() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.calls))
	for _, c := range r.calls {
		out = append(out, strings.Join(c, " "))
	}
	return out
}

// A-153, 22.10: Start applied the install-time 2012 for every user, with no
// mieru host in the panel. It renders nothing now; the first push does.
func TestStartServesNothingUntilAPushNamesAnInbound(t *testing.T) {
	runner := &recordingRunner{}
	a, _ := managedAdapter(t, runner)
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := a.AddUser(core.User{UserID: "u-1", Username: "alice", XrayUUID: "uuid-a"}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if calls := runner.joined(); len(calls) != 0 {
		t.Fatalf("mita was told something before any inbound: %v", calls)
	}
	if a.Provisioned() {
		t.Fatal("provisioned with no inbound")
	}

	body, _ := json.Marshal(map[string]any{"mtu": 1400})
	if err := a.ApplyIdentifiedInbound("in-1", 9012, body); err != nil {
		t.Fatalf("ApplyIdentifiedInbound: %v", err)
	}
	calls := runner.joined()
	want := []string{"apply config", "reload", "start"}
	if len(calls) != len(want) {
		t.Fatalf("calls %v, want apply config, reload, start", calls)
	}
	for i, w := range want {
		if !strings.Contains(calls[i], w) {
			t.Fatalf("call %d is %q, want %q (all: %v)", i, calls[i], w, calls)
		}
	}
	if !a.Provisioned() {
		t.Fatal("not provisioned after its first inbound")
	}
}

// Idle stops the proxy and forgets the inbounds; the same push brings it back.
func TestIdleStopsMitaAndTheSamePushBringsItBack(t *testing.T) {
	runner := &recordingRunner{}
	a, _ := managedAdapter(t, runner)
	body, _ := json.Marshal(map[string]any{"mtu": 1400})
	if err := a.ApplyIdentifiedInbound("in-1", 9012, body); err != nil {
		t.Fatal(err)
	}
	if err := a.Idle(context.Background()); err != nil {
		t.Fatalf("Idle: %v", err)
	}
	calls := runner.joined()
	if last := calls[len(calls)-1]; !strings.HasSuffix(last, " stop") {
		t.Fatalf("Idle did not stop mita: %v", calls)
	}
	if a.Provisioned() {
		t.Fatal("still provisioned after Idle")
	}
	if err := a.ApplyIdentifiedInbound("in-1", 9012, body); err != nil {
		t.Fatal(err)
	}
	calls = runner.joined()
	if last := calls[len(calls)-1]; !strings.HasSuffix(last, " start") {
		t.Fatalf("the same push after Idle did not start mita again: %v", calls)
	}
}

// A-055 for mieru: two inbounds are two pairs of bindings in one config,
// and a removed one goes away.
func TestTwoInboundsAreServedAndARemovedOneGoes(t *testing.T) {
	runner := &recordingRunner{}
	a, path := managedAdapter(t, runner)
	body, _ := json.Marshal(map[string]any{"mtu": 1400})
	if err := a.ApplyIdentifiedInbound("in-1", 9012, body); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyIdentifiedInbound("in-2", 9013, body); err != nil {
		t.Fatalf("second inbound: %v", err)
	}
	if got := bindingPorts(t, path); got != "9012/TCP 9012/UDP 9013/TCP 9013/UDP" {
		t.Fatalf("bindings %q, want both inbounds", got)
	}
	if err := a.RetainInbounds([]string{"in-2"}); err != nil {
		t.Fatal(err)
	}
	if got := bindingPorts(t, path); got != "9013/TCP 9013/UDP" {
		t.Fatalf("bindings after removing in-1: %q", got)
	}
	if err := a.RetainInbounds(nil); err != nil {
		t.Fatal(err)
	}
	calls := runner.joined()
	if last := calls[len(calls)-1]; !strings.HasSuffix(last, " stop") {
		t.Fatalf("the last inbound removed did not stop mita: %v", calls)
	}
}

// mita keeps one MTU per process: a second inbound with another one is
// refused by name and not stored.
func TestASecondInboundWithAnotherMTUIsRefused(t *testing.T) {
	a, _ := managedAdapter(t, &recordingRunner{})
	if err := a.ApplyIdentifiedInbound("in-1", 9012, []byte(`{"mtu":1400}`)); err != nil {
		t.Fatal(err)
	}
	err := a.ApplyIdentifiedInbound("in-2", 9013, []byte(`{"mtu":1280}`))
	if err == nil || !strings.Contains(err.Error(), "MTU") {
		t.Fatalf("expected an MTU refusal, got %v", err)
	}
	if _, held := a.inbounds["in-2"]; held {
		t.Fatal("the refused inbound was stored")
	}
	if err := a.ApplyIdentifiedInbound("in-3", 9012, []byte(`{"mtu":1400}`)); err == nil {
		t.Fatal("a second inbound on a taken port was accepted")
	}
}

// A-198, 22.10: a new agent over a mita the old one left RUNNING. The first
// push without mieru must stop it, though this agent never started it.
func TestTheFirstIdleAfterAnUpdateStopsTheMitaLeftRunning(t *testing.T) {
	runner := &recordingRunner{}
	a, _ := managedAdapter(t, runner)
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := a.Idle(context.Background()); err != nil {
		t.Fatal(err)
	}
	calls := runner.joined()
	if len(calls) != 1 || !strings.HasSuffix(calls[0], " stop") {
		t.Fatalf("calls %v, want one mita stop", calls)
	}
	// After that, an idle mita is known idle: no stop on every push.
	if err := a.Idle(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := len(runner.joined()); n != 1 {
		t.Fatalf("a second Idle stopped mita again: %v", runner.joined())
	}
}

// A-199, 22.10: a binding re-created on the same port under a new id, in one
// push. The server scopes the push first, so the new one is not refused
// against the one it replaces, and mita keeps serving.
func TestABindingRecreatedOnTheSamePortIsNotRefused(t *testing.T) {
	runner := &recordingRunner{}
	a, path := managedAdapter(t, runner)
	if err := a.ApplyIdentifiedInbound("old", 9012, []byte(`{"mtu":1400}`)); err != nil {
		t.Fatal(err)
	}
	// The push, in the server's order: scope, apply, retain.
	a.ScopePush([]string{"new"})
	if err := a.ApplyIdentifiedInbound("new", 9012, []byte(`{"mtu":1400}`)); err != nil {
		t.Fatalf("the re-created binding was refused: %v", err)
	}
	if err := a.RetainInbounds([]string{"new"}); err != nil {
		t.Fatal(err)
	}
	if got := bindingPorts(t, path); got != "9012/TCP 9012/UDP" {
		t.Fatalf("bindings %q", got)
	}
	for _, c := range runner.joined() {
		if strings.HasSuffix(c, " stop") {
			t.Fatalf("mita was stopped: %v", runner.joined())
		}
	}
}

// A push that only deletes: the scope takes the inbound out, nothing is
// applied for mieru, and RetainInbounds still renders without it.
func TestAPushThatOnlyDeletesStillRendersWithoutTheDeletedOne(t *testing.T) {
	a, path := managedAdapter(t, &recordingRunner{})
	_ = a.ApplyIdentifiedInbound("in-1", 9012, []byte(`{"mtu":1400}`))
	_ = a.ApplyIdentifiedInbound("in-2", 9013, []byte(`{"mtu":1400}`))
	a.ScopePush([]string{"in-2"})
	if err := a.ApplyIdentifiedInbound("in-2", 9013, []byte(`{"mtu":1400}`)); err != nil {
		t.Fatal(err)
	}
	if err := a.RetainInbounds([]string{"in-2"}); err != nil {
		t.Fatal(err)
	}
	if got := bindingPorts(t, path); got != "9013/TCP 9013/UDP" {
		t.Fatalf("bindings %q, want in-2 alone", got)
	}
}

func bindingPorts(t *testing.T, path string) string {
	t.Helper()
	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cfg serverConfig
	if err := json.Unmarshal(blob, &cfg); err != nil {
		t.Fatal(err)
	}
	parts := make([]string, 0, len(cfg.PortBindings))
	for _, b := range cfg.PortBindings {
		parts = append(parts, fmt.Sprintf("%d/%s", b.Port, b.Protocol))
	}
	return strings.Join(parts, " ")
}
