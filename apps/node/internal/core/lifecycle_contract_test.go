package core_test

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/mieru"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/mtproto"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/shadowsocks"
)

// The lifecycle every adapter promises, asked of three of them at once.
//
// `Provisioned`, `Start`, `Stop` and `Healthy` are four separate answers to one
// question — is this core able to serve — and each adapter writes them out
// again. Nothing compared them. What the panel does with the answers is not
// symmetric either: `Healthy` feeds /healthz and therefore the node's status,
// so an adapter that says yes while serving nothing is a green node with a dead
// protocol on it, which is the shape this fork keeps finding.
//
// None of this needs a binary. Every adapter has a config-only mode
// (`BinaryPath == ""`) in which Start renders and writes the config and stops
// there, which is the mode these run in — so the contract is exercised on the
// real code with no mtg, no xray and no mita on the machine.
//
// The one place the three legitimately differ is Healthy, and the difference is
// structural rather than drift: mtproto and shadowsocks own a subprocess and
// ask whether it is running; mita owns its own lifecycle under systemd, so the
// mieru adapter has no process to ask about and reports whether the config it
// rendered was accepted. That is the honest maximum for it, and stating it here
// is what stops the difference from looking like one of them being wrong.

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// adapterCase is one adapter in two configurations: unprovisioned (Start must
// defer) and provisioned (Start must render).
type adapterCase struct {
	name string
	// build returns an adapter in config-only mode. `ready` false = missing the
	// one field that makes it servable.
	build func(t *testing.T, ready bool) (core.CoreAdapter, string)
	// provisionable adapters also implement core.Provisionable.
	provisionable bool
}

func cases() []adapterCase {
	return []adapterCase{
		{
			name:          "mtproto",
			provisionable: true,
			build: func(t *testing.T, ready bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "config.toml")
				in := mtproto.InboundConfig{ListenPort: 443, StatsPort: 3129}
				if ready {
					in.Domain = "example.com"
					in.Secret = "ee" + "00112233445566778899aabbccddeeff" + "6578616d706c652e636f6d"
				}
				return mtproto.New(mtproto.Config{ConfigPath: cfgPath, Inbound: in}, quiet()), cfgPath
			},
		},
		{
			name:          "shadowsocks",
			provisionable: true,
			build: func(t *testing.T, ready bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "shadowsocks.json")
				in := shadowsocks.InboundConfig{ListenPort: 8388, ApiPort: 8081, ServerPSK: "c2VydmVyLXBzay0zMi1ieXRlcy1sb25nLWFhYWE="}
				if ready {
					in.Method = "2022-blake3-aes-256-gcm"
				}
				return shadowsocks.New(shadowsocks.Config{ConfigPath: cfgPath, Inbound: in}, quiet()), cfgPath
			},
		},
		{
			name: "mieru",
			build: func(t *testing.T, _ bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "server.json")
				return mieru.New(mieru.Config{
					ConfigPath: cfgPath,
					Inbound:    mieru.InboundConfig{ListenPort: 2012, MTU: 1400, LoggingLevel: "INFO"},
				}, quiet()), cfgPath
			},
		},
	}
}

func TestAnAdapterIsNotHealthyBeforeItStarts(t *testing.T) {
	// The one answer all three must give identically, and the one that matters
	// most: a node whose adapter has never started must not report a protocol
	// it cannot serve.
	for _, c := range cases() {
		t.Run(c.name, func(t *testing.T) {
			a, _ := c.build(t, true)
			if a.Healthy() {
				t.Error("reported healthy before Start was ever called")
			}
		})
	}
}

func TestStartRendersAndThenReportsHealthy(t *testing.T) {
	for _, c := range cases() {
		t.Run(c.name, func(t *testing.T) {
			a, cfgPath := c.build(t, true)
			if err := a.Start(context.Background()); err != nil {
				t.Fatalf("Start: %v", err)
			}
			// The control: "healthy" has to mean something happened. In
			// config-only mode the observable thing is the rendered file.
			st, err := os.Stat(cfgPath)
			if err != nil {
				t.Fatalf("Start reported success and wrote no config at %s: %v", cfgPath, err)
			}
			if st.Size() == 0 {
				t.Fatalf("the config at %s is empty", cfgPath)
			}
			if !a.Healthy() {
				t.Error("rendered its config and still reports unhealthy")
			}
		})
	}
}

func TestStopMakesAnAdapterUnhealthyAgain(t *testing.T) {
	// Stop is what the agent calls on shutdown and on a protocol being taken
	// off a node. An adapter that keeps saying healthy after it would keep the
	// node advertising a protocol it no longer serves.
	for _, c := range cases() {
		t.Run(c.name, func(t *testing.T) {
			a, _ := c.build(t, true)
			if err := a.Start(context.Background()); err != nil {
				t.Fatalf("Start: %v", err)
			}
			if !a.Healthy() {
				t.Fatal("did not become healthy, so Stop below proves nothing")
			}
			if err := a.Stop(context.Background()); err != nil {
				t.Fatalf("Stop: %v", err)
			}
			if a.Healthy() {
				t.Error("still healthy after Stop")
			}
		})
	}
}

func TestAnUnprovisionedAdapterDefersInsteadOfFailing(t *testing.T) {
	// A node is installed before the panel has pushed an inbound, so Start runs
	// with nothing to render. It must return nil — an error here crash-loops
	// the agent, which is how naive (cycle #8) and amneziawg (cycle #6) were
	// both found — and it must not claim to be serving.
	for _, c := range cases() {
		if !c.provisionable {
			continue
		}
		t.Run(c.name, func(t *testing.T) {
			a, cfgPath := c.build(t, false)
			p, ok := a.(core.Provisionable)
			if !ok {
				t.Fatalf("%s was declared provisionable and does not implement the interface", c.name)
			}
			if p.Provisioned() {
				t.Fatal("reported provisioned while missing the field that makes it servable")
			}
			if err := a.Start(context.Background()); err != nil {
				t.Fatalf("Start on an unprovisioned adapter must defer, not fail: %v", err)
			}
			if a.Healthy() {
				t.Error("deferred and still reports healthy")
			}
			if _, err := os.Stat(cfgPath); err == nil {
				t.Error("wrote a config it had nothing to render")
			}
		})
	}
}

func TestProvisionedFlipsWithTheFieldItNames(t *testing.T) {
	// The control on the case above: `Provisioned` has to be capable of both
	// answers, or "not provisioned" is true of an adapter that is never ready.
	for _, c := range cases() {
		if !c.provisionable {
			continue
		}
		t.Run(c.name, func(t *testing.T) {
			ready, _ := c.build(t, true)
			p, _ := ready.(core.Provisionable)
			if !p.Provisioned() {
				t.Error("a fully configured adapter reports itself unprovisioned")
			}
		})
	}
}
