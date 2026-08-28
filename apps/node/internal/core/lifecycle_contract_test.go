package core_test

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"encoding/json"
	"net"
	"sort"
	"strings"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/amneziawg"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/hysteria"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/mieru"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/mtproto"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/naive"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/shadowsocks"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/singbox"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/xray"
)

// The lifecycle every adapter promises, asked of all eight at once.
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
// It used to ask three (mtproto, shadowsocks, mieru). Five adapters stood
// outside it, and one of them had drifted: sing-box set `started = true` before
// knowing whether it had an inbound and did not implement `core.Provisionable`,
// so a registered-but-unconfigured sing-box reached /healthz as
// `running: true` with no `provisioned` field — "configured and serving", when
// neither was true. That is precisely the distinction Provisionable exists to
// make, and the family that had opted out of it is the newest one: TUIC,
// AnyTLS, ShadowTLS and every engine=singbox inbound.
//
// Where the eight legitimately differ, the difference is structural and is
// stated per case rather than left to look like drift:
//
//   - Healthy: mtproto, shadowsocks, naive, xray and sing-box own a subprocess
//     and ask whether it runs; mita owns its own lifecycle under systemd, so
//     mieru has no process to ask about and reports whether the config it
//     rendered was accepted; amneziawg asks the kernel about its interface.
//   - hysteria does not render on Start at all. Its Start brings up the local
//     auth-callback listener, and the config is written by ApplyInbound, so it
//     takes part in the two cases that are about health and not about a file.
//     Its own half is covered in core/hysteria/lifecycle_test.go.
//   - sing-box takes its inbound from ApplyInbound rather than from Config, so
//     its "ready" build pushes one.

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// freePort reserves an ephemeral port and hands back the number. hysteria's
// Start binds its auth callback for real, and its Config reads 0 as "not set"
// and substitutes 9000 — which would collide with a developer's running agent.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a port: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// adapterCase is one adapter in two configurations: unprovisioned (Start must
// defer) and provisioned (Start must render).
type adapterCase struct {
	name string
	// build returns an adapter in config-only mode. `ready` false = missing the
	// one field that makes it servable.
	build func(t *testing.T, ready bool) (core.CoreAdapter, string)
	// provisionable adapters also implement core.Provisionable.
	provisionable bool
	// rendersOnStart is true for every adapter whose Start writes its config
	// when there is one to write. Only hysteria sets it false, and the field is
	// declared inverted (`skipRender`) nowhere on purpose: a new adapter that
	// forgets to set anything is compared like the other seven, which is the
	// safe default for a contract.
	rendersOnStart bool
}

func cases() []adapterCase {
	out := casesRaw()
	for i := range out {
		// Default to "renders", so an adapter added without thinking about it is
		// held to the same promise as the rest. hysteria opts out explicitly.
		if out[i].name != "hysteria" {
			out[i].rendersOnStart = true
		}
	}
	return out
}

func casesRaw() []adapterCase {
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
			name:          "amneziawg",
			provisionable: true,
			build: func(t *testing.T, ready bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "awg0.conf")
				in := amneziawg.InboundConfig{
					Interface: "awg0", ListenPort: 51820, Address: "10.66.66.1/24",
					Jc: 4, Jmin: 40, Jmax: 70,
					S1: 72, S2: 56, S3: 32, S4: 16,
					H1: 100, H2: 200, H3: 300, H4: 400,
				}
				if ready {
					in.PrivateKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
				}
				// AwgQuickBin empty → unmanaged, no CLI is invoked.
				return amneziawg.New(amneziawg.Config{
					Protocol: "amneziawg", ConfigPath: cfgPath, Inbound: in,
				}, quiet()), cfgPath
			},
		},
		{
			name:          "naive",
			provisionable: true,
			build: func(t *testing.T, ready bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "Caddyfile")
				in := naive.InboundConfig{TLSEmail: "ops@example.com"}
				if ready {
					in.Hostname = "n1.example.com"
				}
				// CaddyBin empty → no subprocess.
				return naive.New(naive.Config{CaddyfilePath: cfgPath, Inbound: in}, quiet()), cfgPath
			},
		},
		{
			name:          "xray",
			provisionable: true,
			build: func(t *testing.T, ready bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "config.json")
				in := xray.InboundConfig{
					RealityDest:        "www.cloudflare.com:443",
					RealityServerNames: []string{"www.cloudflare.com"},
					RealityShortIDs:    []string{"abc123"},
				}
				if ready {
					in.RealityPrivateKey = "fake-private-key-for-testing"
				}
				// BinaryPath empty → config-only, no preflight and no spawn.
				return xray.New(xray.Config{ConfigPath: cfgPath, Inbound: in}, quiet()), cfgPath
			},
		},
		{
			name:          "singbox",
			provisionable: true,
			build: func(t *testing.T, ready bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "config.json")
				a := singbox.New(singbox.Config{Protocol: "tuic", ConfigPath: cfgPath}, quiet())
				if ready {
					// Unlike the others, this adapter's inbound arrives through
					// ApplyInbound rather than through Config.
					if err := a.ApplyInbound(8443, json.RawMessage(`{}`)); err != nil {
						t.Fatalf("singbox ApplyInbound: %v", err)
					}
				}
				return a, cfgPath
			},
		},
		{
			name: "hysteria",
			// No Provisionable and no render on Start: Start brings up the auth
			// callback, ApplyInbound writes the config. Both are covered in
			// core/hysteria/lifecycle_test.go; here it answers the two questions
			// every adapter answers.
			rendersOnStart: false,
			build: func(t *testing.T, _ bool) (core.CoreAdapter, string) {
				return hysteria.New(hysteria.Config{
					AuthCallbackHost: "127.0.0.1",
					AuthCallbackPort: freePort(t),
				}, quiet()), ""
			},
		},
		{
			// Not Provisionable, and unlike every other adapter here that is a
			// statement about mieru rather than an omission. What makes the
			// others deferrable is a field the PANEL pushes and the node
			// cannot invent: mtproto waits for a domain, xray for an inbound.
			// mieru's config is rendered entirely from the agent's own
			// environment — MITA_PORT defaults to 2012, MTU to 1400 — so there
			// is no state in which it is registered and missing something. The
			// case below (TestTheProvisionableFlagMatchesTheAdapter) is what
			// keeps that from silently going stale: the day mieru grows a
			// `Provisioned`, this table has to say so.
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
			// config-only mode the observable thing is the rendered file — for
			// every adapter but hysteria, whose Start brings up a listener and
			// whose config is written by ApplyInbound instead.
			if c.rendersOnStart {
				st, err := os.Stat(cfgPath)
				if err != nil {
					t.Fatalf("Start reported success and wrote no config at %s: %v", cfgPath, err)
				}
				if st.Size() == 0 {
					t.Fatalf("the config at %s is empty", cfgPath)
				}
			}
			if !a.Healthy() {
				t.Error("started with everything it needs and still reports unhealthy")
			}
			t.Cleanup(func() { _ = a.Stop(context.Background()) })
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
			// Twice, because the agent's shutdown path calls Stop for every
			// adapter regardless of what already happened to it.
			if err := a.Stop(context.Background()); err != nil {
				t.Errorf("second Stop: %v", err)
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
				t.Error("deferred and still reports healthy: a green card over a protocol serving nobody")
			}
			if p.Provisioned() {
				t.Error("Start deferred and Provisioned says yes; the two must read the same condition")
			}
			if _, err := os.Stat(cfgPath); err == nil {
				t.Error("wrote a config it had nothing to render")
			}
			t.Cleanup(func() { _ = a.Stop(context.Background()) })
		})
	}
}

// The `provisionable` column is a claim about each adapter, and until now it
// was only checked in one direction: an adapter declared provisionable must
// implement the interface (TestAnUnprovisionedAdapterDefersInsteadOfFailing
// fails loudly if it does not). The other direction was open, and it is the one
// that goes wrong quietly — an adapter that GAINS `Provisioned` while its row
// still says false is skipped by both provisioning cases, and skipping looks
// exactly like passing.
//
// That is not hypothetical bookkeeping: two of this file's rows carry an
// exclusion, and one of them (hysteria) explains itself while the other (mieru)
// did not. An unexplained exclusion is the shape this fork keeps finding, so
// the explanation is now checkable rather than prose.
func TestTheProvisionableFlagMatchesTheAdapter(t *testing.T) {
	seen := 0
	for _, c := range cases() {
		t.Run(c.name, func(t *testing.T) {
			a, _ := c.build(t, true)
			t.Cleanup(func() { _ = a.Stop(context.Background()) })
			_, implements := a.(core.Provisionable)
			if implements {
				seen++
			}
			if implements && !c.provisionable {
				t.Errorf("%s implements core.Provisionable and its row says provisionable:false, "+
					"so both provisioning cases skip it silently. Set the flag.", c.name)
			}
			if !implements && c.provisionable {
				t.Errorf("%s is declared provisionable and does not implement core.Provisionable", c.name)
			}
		})
	}
	// The control: if `build` ever stopped returning adapters that implement
	// the interface at all, every comparison above would agree with an empty
	// world.
	if seen == 0 {
		t.Error("no adapter in the contract implements core.Provisionable; the comparison above is vacuous")
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

// The control on the list itself.
//
// This file compared three adapters while eight existed, and the five outside
// it included the one that had drifted. Nothing said so: a contract test that
// covers a third of its subject reads exactly like one that covers all of it.
// So the list is checked against the packages on disk, mechanically — an
// adapter is any sibling package that declares `func (a *Adapter) Start(`, which
// is the method this file is about.
func TestEveryAdapterIsInTheContract(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read the core package dir: %v", err)
	}

	var onDisk []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		files, err := os.ReadDir(e.Name())
		if err != nil {
			continue
		}
		for _, f := range files {
			if !strings.HasSuffix(f.Name(), ".go") || strings.HasSuffix(f.Name(), "_test.go") {
				continue
			}
			src, err := os.ReadFile(filepath.Join(e.Name(), f.Name()))
			if err != nil {
				continue
			}
			if strings.Contains(string(src), "func (a *Adapter) Start(") {
				onDisk = append(onDisk, e.Name())
				break
			}
		}
	}
	sort.Strings(onDisk)

	// The control's own control: an empty scan would make the comparison below
	// vacuous, and "found nothing on disk" is also what a moved package or a
	// renamed method looks like.
	if len(onDisk) < 5 {
		t.Fatalf("only %d adapter packages found (%v); the scan stopped matching and this comparison is empty",
			len(onDisk), onDisk)
	}

	covered := map[string]bool{}
	for _, c := range cases() {
		covered[c.name] = true
	}
	var missing []string
	for _, name := range onDisk {
		if !covered[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Errorf("these adapters implement the lifecycle and are not compared against it: %v\n"+
			"      Add a case to casesRaw(). An adapter outside this file is one whose Start, Stop,\n"+
			"      Healthy and Provisioned agree with nothing.", missing)
	}

	// And the other direction: a case whose package is gone would keep passing
	// forever against a fixture nobody ships.
	for name := range covered {
		found := false
		for _, d := range onDisk {
			if d == name {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("case %q has no adapter package behind it any more", name)
		}
	}
}

// Owning a process means being able to say why it died.
//
// `core.FailureReporter` is optional, and optional is how five of the six
// subprocess-owning adapters came to implement nothing. The panel has printed
// reasons since composeDownMessage landed — `not running: xray (...bind:
// address already in use)` — and for every core but xray it printed the name
// alone, which §45 had already called out as true and useless. Nothing said so:
// an absent optional interface looks exactly like a core that had nothing to
// report.
//
// So the question is asked of the packages: an adapter that holds a
// *subprocess.Subprocess has a last line to hand over, and must.
// subprocessOwners is the set of adapter packages that hold a
// *subprocess.Subprocess, read off the source rather than listed here so a new
// adapter is covered without anyone remembering to add it.
func subprocessOwners(t *testing.T) map[string]bool {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read the core package dir: %v", err)
	}
	owners := map[string]bool{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		files, err := os.ReadDir(e.Name())
		if err != nil {
			continue
		}
		for _, f := range files {
			if !strings.HasSuffix(f.Name(), ".go") || strings.HasSuffix(f.Name(), "_test.go") {
				continue
			}
			src, err := os.ReadFile(filepath.Join(e.Name(), f.Name()))
			if err != nil {
				continue
			}
			if strings.Contains(string(src), "*subprocess.Subprocess") {
				owners[e.Name()] = true
				break
			}
		}
	}
	return owners
}

func TestEveryAdapterThatOwnsAProcessSaysWhyItDied(t *testing.T) {
	owners := subprocessOwners(t)

	// The control: an empty scan would make the loop below iterate over nothing
	// and pass, which is the shape that let this sit unnoticed.
	if len(owners) < 4 {
		t.Fatalf("only %d adapters found holding a subprocess (%v); the scan stopped matching",
			len(owners), owners)
	}

	var silent []string
	for _, c := range cases() {
		if !owners[c.name] {
			continue
		}
		a, _ := c.build(t, true)
		t.Cleanup(func() { _ = a.Stop(context.Background()) })
		if _, ok := a.(core.FailureReporter); !ok {
			silent = append(silent, c.name)
		}
	}
	sort.Strings(silent)
	if len(silent) > 0 {
		t.Errorf("these adapters own a process and cannot say why it died: %v\n"+
			"      The panel prints `not running: <core> (<reason>)`; without FailureReporter the\n"+
			"      operator gets the name and has to go find the node's journal themselves.", silent)
	}
}

// Owning a process also means counting how often it was restarted.
//
// The supervisor restarts a crashed core for ALL six adapters — every one sets
// MaxRestarts — and told exactly one of them it had done so: `OnRestart` was
// wired by xray and by nobody else. A restart that SUCCEEDS is the case that
// matters, because the core comes back, the node stays online, the status alert
// never fires, and every live connection was dropped in silence. The panel has
// an alert for it (`nodes.cron.ts`, "Core restarted") that five cores could
// never trigger.
func TestEveryAdapterThatOwnsAProcessCountsItsRestarts(t *testing.T) {
	owners := subprocessOwners(t)
	if len(owners) < 4 {
		t.Fatalf("only %d adapters found holding a subprocess (%v); the scan stopped matching",
			len(owners), owners)
	}

	var silent []string
	for _, c := range cases() {
		if !owners[c.name] {
			continue
		}
		a, _ := c.build(t, true)
		t.Cleanup(func() { _ = a.Stop(context.Background()) })
		if _, ok := a.(core.RestartReporter); !ok {
			silent = append(silent, c.name)
		}
	}
	sort.Strings(silent)
	if len(silent) > 0 {
		t.Errorf("these adapters own a process the supervisor restarts and report no tally: %v", silent)
	}
}

// And the wiring behind it, asked of the source: a tally the supervisor never
// feeds stays at zero forever, and zero is indistinguishable from a core that
// simply has not crashed. Every subprocess.Config literal must name OnRestart.
func TestEverySupervisedCoreSubscribesToItsOwnRestarts(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read the core package dir: %v", err)
	}
	found, missing := 0, []string(nil)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		files, _ := os.ReadDir(e.Name())
		for _, f := range files {
			if !strings.HasSuffix(f.Name(), ".go") || strings.HasSuffix(f.Name(), "_test.go") {
				continue
			}
			src, err := os.ReadFile(filepath.Join(e.Name(), f.Name()))
			if err != nil {
				continue
			}
			body := string(src)
			at := strings.Index(body, "subprocess.New(subprocess.Config{")
			if at < 0 {
				continue
			}
			found++
			end := strings.Index(body[at:], "})")
			if end < 0 || !strings.Contains(body[at:at+end], "OnRestart:") {
				missing = append(missing, e.Name()+"/"+f.Name())
			}
		}
	}
	// The control: no literals found means the constructor was renamed and this
	// comparison is empty, which is how the gap survived in the first place.
	if found < 4 {
		t.Fatalf("only %d subprocess.Config literals found; the scan stopped matching", found)
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("these spawn a supervised core and never hear that it restarted: %v", missing)
	}
}
