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
