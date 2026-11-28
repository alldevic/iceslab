package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/chain"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
	"github.com/icecompany-tech/iceslab/apps/node/internal/payload"
)

/*
22.10: the chain refused a new block and kept running the previous one, and the
user's core was drawn to the REFUSED block's hand-off anyway. With other socks
ports in the new block, a cascade entry sent its users to a loopback port nobody
listened on until the next push that applied.
*/

const (
	oldHandover = `{"outbounds":[{"tag":"cascade-link-out-chain-d1","protocol":"socks","settings":{"servers":[{"port":26000}]}}]}`
	newHandover = `{"outbounds":[{"tag":"cascade-link-out-chain-d1","protocol":"socks","settings":{"servers":[{"port":27000}]}}]}`
)

func blockWithPort(port int, handover string, config string) *dto.NodeChain {
	return &dto.NodeChain{
		Engine:        "singbox",
		Config:        json.RawMessage(config),
		Socks:         []dto.ChainSocks{{Tag: 0, Port: port}},
		SocksPassword: "chain-socks-fixture-password-0000",
		UserCore:      &dto.ChainUserCore{Engine: "xray", Fragments: json.RawMessage(handover)},
	}
}

// pickyChain is a manager whose engine runs (a stub that sleeps) and whose
// check refuses any config that says "refuse-me".
func pickyChain(t *testing.T) *chain.Manager {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "sing-box")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nsleep 60\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := chain.New(chain.Config{
		BinaryPath: bin,
		ConfigPath: filepath.Join(dir, "chain", "config.json"),
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) >= 3 && args[0] == "check" {
				blob, err := os.ReadFile(args[2])
				if err != nil {
					return nil, err
				}
				if strings.Contains(string(blob), "refuse-me") {
					return []byte("FATAL decode config: unknown field"), errors.New("exit status 1")
				}
			}
			if len(args) > 0 && args[0] == "version" {
				return []byte("sing-box version 1.13.14\n"), nil
			}
			return nil, nil
		},
	})
	t.Cleanup(func() { _ = m.Apply(context.Background(), nil) })
	return m
}

func TestARefusedChainKeepsTheCoresOnTheHandoffThatRuns(t *testing.T) {
	xray := &cascadeCore{fakeCore: fakeCore{name: "vless", engine: "xray", running: true}}
	store := filepath.Join(t.TempDir(), "inbounds.json")
	s, err := New(Config{
		Logger:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		Payload:           &payload.Payload{},
		Adapters:          []core.CoreAdapter{xray},
		Chain:             pickyChain(t),
		InboundsStorePath: store,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	good := blockWithPort(26000, oldHandover, `{"log":{"level":"warn"},"outbounds":[{"type":"direct","tag":"direct"}]}`)
	refused := blockWithPort(27000, newHandover, `{"log":{"level":"warn"},"refuse-me":true}`)

	push := func(b *dto.NodeChain) int {
		body, _ := json.Marshal(dto.ApplyInboundsRequest{Chain: b})
		req := httptest.NewRequest(http.MethodPost, "/applyInbounds", strings.NewReader(string(body)))
		rec := httptest.NewRecorder()
		s.handleApplyInbounds(rec, req)
		return rec.Code
	}
	if code := push(good); code != http.StatusOK {
		t.Fatalf("good chain push answered %d", code)
	}
	if code := push(refused); code != http.StatusInternalServerError {
		t.Fatalf("a refused chain must fail the push, answered %d", code)
	}

	if len(xray.got) != 2 {
		t.Fatalf("the cascade receiver was called %d times, want twice", len(xray.got))
	}
	if string(xray.got[1]) != oldHandover {
		t.Fatalf("after the chain refused the new block, the core was drawn to %s, want the running chain's %s",
			xray.got[1], oldHandover)
	}

	back, err := readPushStore(store)
	if err != nil {
		t.Fatalf("readPushStore: %v", err)
	}
	if back.Chain == nil || len(back.Chain.Socks) != 1 || back.Chain.Socks[0].Port != 26000 {
		t.Fatalf("the store must hold the chain that runs (26000), got %+v", back.Chain)
	}
}

// With nothing accepted before, the refused block's hand-off still goes to
// the core: its port is empty and the cascade fails closed. No hand-off at all
// would send the entry's users straight out of the entry country.
func TestARefusedFirstChainStillFailsClosed(t *testing.T) {
	xray := &cascadeCore{fakeCore: fakeCore{name: "vless", engine: "xray", running: true}}
	s, err := New(Config{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Payload:  &payload.Payload{},
		Adapters: []core.CoreAdapter{xray},
		Chain:    pickyChain(t),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	refused := blockWithPort(27000, newHandover, `{"refuse-me":true}`)
	s.applyPush(context.Background(), dto.ApplyInboundsRequest{Chain: refused})

	if len(xray.got) != 1 || string(xray.got[0]) != newHandover {
		t.Fatalf("a refused first chain must still hand the core its drawing, got %s", xray.got)
	}
}

/*
19.15, item 4: an entry whose hand-off no core took is closed, not left to draw
`direct`. Three ways it happened, and the one way it must not change.
*/

// closableEntryCore is a hysteria entry that records how it was told about the cascade.
type closableEntryCore struct {
	cascadeCore
	applyErr error
	closes   []string
	closed   string
}

func (c *closableEntryCore) ApplyCascade(f json.RawMessage) error {
	c.got = append(c.got, f)
	return c.applyErr
}

func (c *closableEntryCore) CloseCascade(reason string) error {
	c.closes = append(c.closes, reason)
	c.closed = reason
	return errors.New(reason)
}

func (c *closableEntryCore) CascadeClosed() string { return c.closed }

func closedEntryBlock(socks *dto.ChainUserCoreSocks) *dto.NodeChain {
	return &dto.NodeChain{
		Engine:        "singbox",
		Config:        json.RawMessage(`{"log":{"level":"warn"},"outbounds":[{"type":"direct","tag":"direct"}]}`),
		Socks:         []dto.ChainSocks{{Tag: 0, Port: 26000}},
		SocksPassword: "chain-socks-fixture-password-0000",
		UserCore:      &dto.ChainUserCore{Engine: dto.EngineHysteria, Socks: socks},
	}
}

func closableEntryServer(t *testing.T, withChain bool, c core.CoreAdapter) *Server {
	t.Helper()
	cfg := Config{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Payload:  &payload.Payload{},
		Adapters: []core.CoreAdapter{c},
	}
	if withChain {
		cfg.Chain = pickyChain(t)
	}
	s, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func hasReason(reasons []string, part string) bool {
	for _, r := range reasons {
		if strings.Contains(r, part) {
			return true
		}
	}
	return false
}

func TestAnEntryThatRefusesTheHandoffFailsThePushAndSaysSo(t *testing.T) {
	hy := &closableEntryCore{cascadeCore: cascadeCore{fakeCore: fakeCore{name: "hysteria", engine: "hysteria", running: true}}, applyErr: errors.New("hysteria chain hand-off: port 0 is not a port")}
	s := closableEntryServer(t, true, hy)
	_, failed, reasons := s.applyPush(context.Background(), dto.ApplyInboundsRequest{
		Chain: closedEntryBlock(&dto.ChainUserCoreSocks{Port: 26000, Username: "chain", Password: "chain-socks-fixture-password-0000"}),
	})
	if failed != 1 || !hasReason(reasons, "cascade (hysteria)") || !hasReason(reasons, "not a port") {
		t.Fatalf("failed %d, reasons %v: the refused hand-off must count and say why", failed, reasons)
	}
}

func TestAMalformedUserCoreClosesTheEntryItNames(t *testing.T) {
	hy := &closableEntryCore{cascadeCore: cascadeCore{fakeCore: fakeCore{name: "hysteria", engine: "hysteria", running: true}}}
	other := &cascadeCore{fakeCore: fakeCore{name: "vless", engine: "xray", running: true}}
	s, err := New(Config{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Payload:  &payload.Payload{},
		Adapters: []core.CoreAdapter{hy, other},
		Chain:    pickyChain(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	// A hysteria block with no socks: Payload refuses it.
	_, failed, reasons := s.applyPush(context.Background(), dto.ApplyInboundsRequest{Chain: closedEntryBlock(nil)})
	if failed != 1 || !hasReason(reasons, "no socks hand-off") {
		t.Fatalf("failed %d, reasons %v", failed, reasons)
	}
	if len(hy.closes) != 1 || !strings.Contains(hy.closes[0], "no socks hand-off") {
		t.Fatalf("the entry was not closed: %v", hy.closes)
	}
	if len(hy.got) != 0 || len(other.got) != 0 {
		t.Fatalf("a refused userCore was delivered as a cascade (%d, %d calls): every other core keeps what it had", len(hy.got), len(other.got))
	}
}

func TestAnAgentWithNoChainManagerClosesTheEntryTheBlockNames(t *testing.T) {
	hy := &closableEntryCore{cascadeCore: cascadeCore{fakeCore: fakeCore{name: "hysteria", engine: "hysteria", running: true}}}
	s := closableEntryServer(t, false, hy)
	_, failed, reasons := s.applyPush(context.Background(), dto.ApplyInboundsRequest{
		Chain: closedEntryBlock(&dto.ChainUserCoreSocks{Port: 26000, Username: "chain", Password: "chain-socks-fixture-password-0000"}),
	})
	if failed != 1 || !hasReason(reasons, "cannot run a chain process") {
		t.Fatalf("failed %d, reasons %v", failed, reasons)
	}
	if len(hy.closes) != 1 || len(hy.got) != 0 {
		t.Fatalf("closes %v, cascade calls %d: the entry must be closed, not told nil", hy.closes, len(hy.got))
	}
}

// The legacy block still draws the entry when the agent has no manager: not closed.
func TestAnAgentWithNoChainManagerKeepsDrawingTheLegacyCascade(t *testing.T) {
	hy := &closableEntryCore{cascadeCore: cascadeCore{fakeCore: fakeCore{name: "hysteria", engine: "hysteria", running: true}}}
	s := closableEntryServer(t, false, hy)
	s.applyPush(context.Background(), dto.ApplyInboundsRequest{
		Chain:   closedEntryBlock(&dto.ChainUserCoreSocks{Port: 26000, Username: "chain", Password: "chain-socks-fixture-password-0000"}),
		Cascade: &dto.NodeCascade{Engine: dto.EngineHysteria, Fragments: json.RawMessage(`{"port":26000,"username":"chain","password":"chain-socks-fixture-password-0000"}`)},
	})
	if len(hy.closes) != 0 || len(hy.got) != 1 {
		t.Fatalf("closes %v, cascade calls %d", hy.closes, len(hy.got))
	}
}

// No cascade on the node at all: the push without a `chain` block is a real nil,
// and the core draws what it always did.
func TestAPushWithNoChainBlockStillTellsTheCoreNil(t *testing.T) {
	hy := &closableEntryCore{cascadeCore: cascadeCore{fakeCore: fakeCore{name: "hysteria", engine: "hysteria", running: true}}}
	s := closableEntryServer(t, true, hy)
	_, failed, _ := s.applyPush(context.Background(), dto.ApplyInboundsRequest{})
	if failed != 0 || len(hy.closes) != 0 || len(hy.got) != 1 || len(hy.got[0]) != 0 {
		t.Fatalf("failed %d, closes %v, calls %q", failed, hy.closes, hy.got)
	}
}

// What the operator sees: the core runs, and says why it serves nobody.
func TestAClosedEntryIsReportedWithItsReasonAndDegradesTheNode(t *testing.T) {
	hy := &closableEntryCore{cascadeCore: cascadeCore{fakeCore: fakeCore{name: "hysteria", engine: "hysteria", running: true}}, closed: "cascade entry closed: no socks hand-off"}
	got := health(t, hy)
	if got.Status != "degraded" {
		t.Fatalf("status %q, want degraded", got.Status)
	}
	c := got.Cores[0]
	if !c.Running || c.Error == nil || !strings.Contains(*c.Error, "cascade entry closed") {
		t.Fatalf("core %+v: running stays true and the reason is its error", c)
	}
	hy.closed = ""
	if got := health(t, hy); got.Status != "ok" || got.Cores[0].Error != nil {
		t.Fatalf("an open entry reads %+v", got)
	}
}

// What is stored is what a restart replays: the refused userCore stays when no
// hand-off was held before, so the restart closes the entry again.
func TestAMalformedUserCoreWithNoEarlierOneIsStoredSoARestartClosesTheEntryAgain(t *testing.T) {
	hy := &closableEntryCore{cascadeCore: cascadeCore{fakeCore: fakeCore{name: "hysteria", engine: "hysteria", running: true}}}
	store := filepath.Join(t.TempDir(), "inbounds.json")
	s, err := New(Config{
		Logger:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		Payload:           &payload.Payload{},
		Adapters:          []core.CoreAdapter{hy},
		Chain:             pickyChain(t),
		InboundsStorePath: store,
	})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(dto.ApplyInboundsRequest{Chain: closedEntryBlock(nil)})
	rec := httptest.NewRecorder()
	s.handleApplyInbounds(rec, httptest.NewRequest(http.MethodPost, "/applyInbounds", strings.NewReader(string(body))))
	back, err := readPushStore(store)
	if err != nil {
		t.Fatal(err)
	}
	if back.Chain == nil || back.Chain.UserCore == nil {
		t.Fatalf("the store dropped the refused userCore: %+v", back.Chain)
	}
}
