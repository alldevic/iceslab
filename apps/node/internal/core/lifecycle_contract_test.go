package core_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

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
// Provisioned, Start, Stop, Healthy and Idle are separate answers to one
// question, is this core able to serve, and each adapter writes them out again.
// Nothing compared them. A Healthy that says yes while serving nothing is a
// green node with a dead protocol on it.
//
// None of this needs a binary. Every adapter has a config-only mode (empty
// binary path) in which Start renders and writes the config and stops there:
// the contract runs on the real code with no xray, mtg or mita on the machine,
// and binds no fixed port (see freePort).
//
// Where the eight legitimately differ, the difference is a field of the row,
// with its reason, and the zero value is the strict contract: a new adapter
// that sets nothing is held to every question.
//
//   - Healthy: mtproto, shadowsocks, naive, xray, sing-box and hysteria own a
//     subprocess and ask whether it runs; amneziawg asks the kernel about its
//     interface; mieru asks `mita status` (cached) when it has a binary and
//     is not waiting for its first user. In config-only mode the first group,
//     amneziawg and mieru answer from their own started flag.
//   - hysteria: Start brings up the local auth-callback listener and writes no
//     config; ApplyInbound writes it. It has no Provisioned. Its own half is
//     covered in core/hysteria (startup_test.go, idle_test.go).
//   - mieru: Start renders nothing (A-153); the inbounds arrive through
//     ApplyInbound, which is also what renders. Healthy is the started flag
//     only without a binary (and while waiting for the first user); with one
//     it asks mita (6.1), which this table cannot, so the exceptions below
//     are of config-only mode and say so.
//   - sing-box: the inbound arrives through ApplyInbound, not Config. Healthy
//     with no inbound is the started flag.
//
// Outside the contract, on purpose:
//
//   - core.Waiter: one adapter (mieru) implements it, and its behaviour is
//     covered by core/mieru/waiting_test.go.
//   - internal/chain: owns a subprocess.Config literal but is not an adapter
//     and lives outside internal/core; it has no restart tally.
//   - core.Absent: the stand-in for a core that is not installed; it has no
//     lifecycle to compare.
//
// Known differences that read like defects, recorded not fixed here (the row
// fields below name each):
//
//   - sing-box answers Healthy=true after a Start that deferred, and after
//     Idle: Healthy is "the agent is started", not "the core serves";
//     Provisioned is what tells the panel it is unconfigured. Kept on purpose
//     (decision of 26.11.2026, milestone 6.3): sing-box stays an explicit
//     exception, base behaviour.
//   - mieru does the same only in config-only mode, where there is no mita to
//     ask. Since 6.1 its Healthy asks `mita status` when a binary is set, so
//     the old reading "Healthy is the started flag" is no longer true of a
//     real node; the covering tests are in core/mieru.
//   - xray's Idle only acts on a live process, so with no binary it changes
//     nothing.

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// freePort reserves an ephemeral port and hands back the number. hysteria's
// Start binds its auth callback for real, and its Config reads 0 as "not set"
// and substitutes 9000, which would collide with a developer's running agent.
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
// defer) and provisioned (Start must serve).
type adapterCase struct {
	name string
	// build returns an adapter in config-only mode and the path of its config.
	// ready=false leaves out what makes it servable.
	build func(t *testing.T, ready bool) (core.CoreAdapter, string)
	// provisionable: the adapter also implements core.Provisionable.
	provisionable bool
	// provisionedBy names what Provisioned reads, and what build(ready) sets.
	provisionedBy string
	// reapply pushes the same config build(ready) holds, through ApplyInbound.
	// Idle's contract is that this brings the adapter back.
	reapply func(t *testing.T, a core.CoreAdapter)

	// Exceptions. Empty means the adapter answers the question like the rest;
	// a non-empty string is the reason it does not.
	noConfigOnStart   string // Start writes no config file
	healthyWhenDefer  string // a deferred Start still leaves Healthy true
	idleKeepsHealthy  string // after Idle (config-only) Healthy is still true
	idleNeverRecovers string // reapply is not asked: no applied config to return to

	// The config-write contract (config_write_contract_test.go).
	//
	// rewrite changes the config the adapter holds, generation gen (1, 2, ...),
	// so that it writes the file again: the unchanged-skip guards in ApplyInbound
	// make a repeated push write nothing. Nil means Start is what writes the
	// file, and a second Start is the rewrite.
	rewrite func(t *testing.T, a core.CoreAdapter, gen int)
	// configNeedsBinary: the adapter writes its config only with a binary to
	// run (the config is checked by the binary before it is put in place), so
	// the config-only mode this table runs in never writes one.
	configNeedsBinary string
}

func rawJSON(s string) json.RawMessage { return json.RawMessage(s) }

func mustApply(t *testing.T, a core.CoreAdapter, port int, cfg string) {
	t.Helper()
	if err := a.ApplyInbound(port, rawJSON(cfg)); err != nil {
		t.Fatalf("%s ApplyInbound: %v", a.Name(), err)
	}
}

func cases() []adapterCase {
	const mtSecret = "ee" + "00112233445566778899aabbccddeeff" + "6578616d706c652e636f6d"
	const awgKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	return []adapterCase{
		{
			name:          "mtproto",
			provisionable: true,
			provisionedBy: "Inbound.Domain and Inbound.Secret",
			build: func(t *testing.T, ready bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "config.toml")
				in := mtproto.InboundConfig{ListenPort: 443, StatsPort: 3129}
				if ready {
					in.Domain = "example.com"
					in.Secret = mtSecret
				}
				return mtproto.New(mtproto.Config{ConfigPath: cfgPath, Inbound: in}, quiet()), cfgPath
			},
			reapply: func(t *testing.T, a core.CoreAdapter) {
				mustApply(t, a, 443, `{"domain":"example.com","secret":"`+mtSecret+`"}`)
			},
		},
		{
			name:          "shadowsocks",
			provisionable: true,
			provisionedBy: "Inbound.Method",
			build: func(t *testing.T, ready bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "shadowsocks.json")
				in := shadowsocks.InboundConfig{ListenPort: 8388, ApiPort: 8081, ServerPSK: "c2VydmVyLXBzay0zMi1ieXRlcy1sb25nLWFhYWE="}
				if ready {
					in.Method = "2022-blake3-aes-256-gcm"
				}
				return shadowsocks.New(shadowsocks.Config{ConfigPath: cfgPath, Inbound: in}, quiet()), cfgPath
			},
			reapply: func(t *testing.T, a core.CoreAdapter) {
				mustApply(t, a, 8388, `{"method":"2022-blake3-aes-256-gcm","serverPsk":"c2VydmVyLXBzay0zMi1ieXRlcy1sb25nLWFhYWE="}`)
			},
		},
		{
			name:          "amneziawg",
			provisionable: true,
			provisionedBy: "Inbound.PrivateKey",
			build: func(t *testing.T, ready bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "awg0.conf")
				in := amneziawg.InboundConfig{
					Interface: "awg0", ListenPort: 51820, Address: "10.66.66.1/24",
					Jc: 4, Jmin: 40, Jmax: 70,
					S1: 72, S2: 56, S3: 32, S4: 16,
					H1: 100, H2: 200, H3: 300, H4: 400,
				}
				if ready {
					in.PrivateKey = awgKey
				}
				// AwgQuickBin empty: unmanaged, no CLI is invoked.
				return amneziawg.New(amneziawg.Config{
					ConfigPath: cfgPath, Inbound: in,
				}, quiet()), cfgPath
			},
			reapply: func(t *testing.T, a core.CoreAdapter) {
				mustApply(t, a, 51820, `{"subnet":"10.66.66.0/24","serverPrivateKey":"`+awgKey+`",`+
					`"obfuscation":{"jc":4,"jmin":40,"jmax":70,"s1":72,"s2":56,"s3":32,"s4":16,"h1":100,"h2":200,"h3":300,"h4":400}}`)
			},
		},
		{
			name:          "naive",
			provisionable: true,
			provisionedBy: "Inbound.Hostname",
			build: func(t *testing.T, ready bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "Caddyfile")
				in := naive.InboundConfig{TLSEmail: "ops@example.com"}
				if ready {
					in.Hostname = "n1.example.com"
				}
				// CaddyBin empty: no subprocess.
				return naive.New(naive.Config{CaddyfilePath: cfgPath, Inbound: in}, quiet()), cfgPath
			},
			reapply: func(t *testing.T, a core.CoreAdapter) {
				mustApply(t, a, 0, `{"hostname":"n1.example.com","tlsEmail":"ops@example.com"}`)
			},
		},
		{
			name:          "xray",
			provisionable: true,
			provisionedBy: "Inbound.RealityPrivateKey (or a pushed inbound)",
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
				// BinaryPath empty: config-only, no preflight and no spawn.
				return xray.New(xray.Config{ConfigPath: cfgPath, Inbound: in}, quiet()), cfgPath
			},
			idleKeepsHealthy:  "Idle acts through the process (it re-renders to an empty set and stops it); with no binary there is none, so it is a no-op",
			idleNeverRecovers: "nothing was taken down, so there is nothing to recover from",
		},
		{
			name:          "singbox",
			provisionable: true,
			provisionedBy: "a pushed inbound (len(inbounds) > 0)",
			build: func(t *testing.T, ready bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "config.json")
				a := singbox.New(singbox.Config{Protocol: "tuic", ConfigPath: cfgPath}, quiet())
				if ready {
					// Unlike the others, the inbound arrives through ApplyInbound
					// and not through Config.
					mustApply(t, a, 8443, `{}`)
				}
				return a, cfgPath
			},
			reapply: func(t *testing.T, a core.CoreAdapter) { mustApply(t, a, 8443, `{}`) },
			// The inbound is applied before Start in build, so the file exists
			// already and "Start wrote it" proves nothing.
			noConfigOnStart:  "the config is written by ApplyInbound, which build runs before Start",
			healthyWhenDefer: "Healthy with no inbound is the started flag: the agent is up, it has nothing to run (adapter.go Healthy)",
			idleKeepsHealthy: "Idle drops the process and the inbounds and keeps the adapter started, by design (adapter.go Idle)",
			configNeedsBinary: "regenerateAndRestart returns before rendering with no BinaryPath, and the config is " +
				"checked by `sing-box check` before it is written: no binary, no file. The write itself is " +
				"atomicfile.Write (adapter.go regenerateAndRestart); the live cases run with SINGBOX_BIN",
		},
		{
			name: "hysteria",
			// No Provisionable, and Start writes no config: it brings up the
			// auth callback, ApplyInbound writes the file.
			build: func(t *testing.T, _ bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "config.yaml")
				// ConfigPath set: ApplyInbound writes the YAML (unset, it
				// accepts in memory only). ServiceUnit empty: no systemctl.
				return hysteria.New(hysteria.Config{
					AuthCallbackHost: "127.0.0.1",
					AuthCallbackPort: freePort(t),
					ConfigPath:       cfgPath,
				}, quiet()), cfgPath
			},
			rewrite: func(t *testing.T, a core.CoreAdapter, gen int) {
				mustApply(t, a, 443, fmt.Sprintf(`{"hostname":"hy.example.com","obfsPassword":"o%d"}`, gen))
			},
			noConfigOnStart:   "Start brings up the auth callback; ApplyInbound writes the config",
			idleKeepsHealthy:  "Idle acts only where systemd runs hysteria (ServiceUnit set); here it is a no-op",
			idleNeverRecovers: "nothing was taken down, so there is nothing to recover from",
		},
		{
			// mieru is Provisionable on "an inbound was pushed". Its config is
			// rendered by ApplyInbound; Start only marks it started (A-153).
			name:          "mieru",
			provisionable: true,
			provisionedBy: "a pushed inbound (len(inbounds) > 0)",
			build: func(t *testing.T, ready bool) (core.CoreAdapter, string) {
				cfgPath := filepath.Join(t.TempDir(), "server.json")
				a := mieru.New(mieru.Config{
					ConfigPath: cfgPath,
					Inbound:    mieru.InboundConfig{ListenPort: 2012, MTU: 1400, LoggingLevel: "INFO"},
				}, quiet())
				if ready {
					mustApply(t, a, 2012, `{"mtu":1400}`)
				}
				return a, cfgPath
			},
			reapply: func(t *testing.T, a core.CoreAdapter) { mustApply(t, a, 2012, `{"mtu":1400}`) },
			rewrite: func(t *testing.T, a core.CoreAdapter, gen int) {
				mustApply(t, a, 2012, fmt.Sprintf(`{"mtu":%d}`, 1300+gen*10))
			},
			noConfigOnStart:  "Start renders nothing (A-153); the config is written by ApplyInbound, which build runs before Start",
			healthyWhenDefer: "config-only mode (no BinaryPath): Healthy has no mita to ask and is the started flag (adapter.go Healthy); with a binary it asks `mita status`. An unconfigured mieru is told apart by Provisioned",
			idleKeepsHealthy: "config-only mode: Idle forgets the inbounds and leaves started alone, and Healthy has no mita to ask (adapter.go Idle, Healthy)",
		},
	}
}

func TestAnAdapterIsNotHealthyBeforeItStarts(t *testing.T) {
	for _, c := range cases() {
		t.Run(c.name, func(t *testing.T) {
			a, _ := c.build(t, true)
			t.Cleanup(func() { _ = a.Stop(context.Background()) })
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
			t.Cleanup(func() { _ = a.Stop(context.Background()) })
			if err := a.Start(context.Background()); err != nil {
				t.Fatalf("Start: %v", err)
			}
			// The control: "healthy" has to mean something happened. In
			// config-only mode the observable thing is the rendered file.
			if c.noConfigOnStart == "" {
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
		})
	}
}

func TestStopMakesAnAdapterUnhealthyAgain(t *testing.T) {
	// Stop is what the agent calls on shutdown and on a protocol being taken
	// off a node: an adapter that keeps saying healthy after it advertises a
	// protocol it no longer serves.
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
			// Twice: the shutdown path calls Stop for every adapter regardless
			// of what already happened to it.
			if err := a.Stop(context.Background()); err != nil {
				t.Errorf("second Stop: %v", err)
			}
		})
	}
}

func TestAnUnprovisionedAdapterDefersInsteadOfFailing(t *testing.T) {
	// A node is installed before the panel has pushed an inbound, so Start runs
	// with nothing to render. It must return nil (an error here crash-loops the
	// agent) and must not claim to be serving.
	for _, c := range cases() {
		if !c.provisionable {
			continue
		}
		t.Run(c.name, func(t *testing.T) {
			a, cfgPath := c.build(t, false)
			t.Cleanup(func() { _ = a.Stop(context.Background()) })
			p, ok := a.(core.Provisionable)
			if !ok {
				t.Fatalf("%s was declared provisionable and does not implement the interface", c.name)
			}
			if p.Provisioned() {
				t.Fatal("reported provisioned while missing what makes it servable")
			}
			if err := a.Start(context.Background()); err != nil {
				t.Fatalf("Start on an unprovisioned adapter must defer, not fail: %v", err)
			}
			if c.healthyWhenDefer == "" && a.Healthy() {
				t.Error("deferred and still reports healthy: a green card over a protocol serving nobody")
			}
			if p.Provisioned() {
				t.Error("Start deferred and Provisioned says yes; the two must read the same condition")
			}
			if _, err := os.Stat(cfgPath); err == nil {
				t.Error("wrote a config it had nothing to render")
			}
		})
	}
}

// The `provisionable` column is checked in both directions. An adapter that
// GAINS Provisioned while its row says false is skipped by every provisioning
// question, and skipping looks exactly like passing.
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
					"so the provisioning questions skip it silently. Set the flag.", c.name)
			}
			if !implements && c.provisionable {
				t.Errorf("%s is declared provisionable and does not implement core.Provisionable", c.name)
			}
			if c.provisionable && c.provisionedBy == "" {
				t.Errorf("%s: a provisionable row names the field Provisioned reads (provisionedBy)", c.name)
			}
		})
	}
	// The control: a build that stopped returning Provisionable adapters would
	// agree with an empty world.
	if seen == 0 {
		t.Error("no adapter in the contract implements core.Provisionable; the comparison above is vacuous")
	}
}

func TestProvisionedFlipsWithTheFieldItNames(t *testing.T) {
	// `Provisioned` has to be capable of both answers, or "not provisioned" is
	// true of an adapter that is never ready.
	for _, c := range cases() {
		if !c.provisionable {
			continue
		}
		t.Run(c.name, func(t *testing.T) {
			ready, _ := c.build(t, true)
			t.Cleanup(func() { _ = ready.Stop(context.Background()) })
			if !ready.(core.Provisionable).Provisioned() {
				t.Errorf("with %s set it reports itself unprovisioned", c.provisionedBy)
			}
			bare, _ := c.build(t, false)
			t.Cleanup(func() { _ = bare.Stop(context.Background()) })
			if bare.(core.Provisionable).Provisioned() {
				t.Errorf("without %s it reports itself provisioned", c.provisionedBy)
			}
		})
	}
}

// Idle is called on every applied push for every core the push does not name:
// it must be repeatable, must leave the core not serving, and must leave it
// able to come back from the next ApplyInbound with the same config
// (core.Idler). In config-only mode some adapters have nothing to stop; their
// row says so.
func TestIdleIsRepeatableAndTheSameConfigBringsTheAdapterBack(t *testing.T) {
	for _, c := range cases() {
		t.Run(c.name, func(t *testing.T) {
			a, _ := c.build(t, true)
			t.Cleanup(func() { _ = a.Stop(context.Background()) })
			idler, ok := a.(core.Idler)
			if !ok {
				t.Fatalf("%s does not implement core.Idler", c.name)
			}
			if err := a.Start(context.Background()); err != nil {
				t.Fatalf("Start: %v", err)
			}
			if err := idler.Idle(context.Background()); err != nil {
				t.Fatalf("Idle: %v", err)
			}
			if err := idler.Idle(context.Background()); err != nil {
				t.Fatalf("second Idle must be a no-op, not an error: %v", err)
			}
			if c.idleKeepsHealthy == "" {
				if a.Healthy() {
					t.Error("still healthy after Idle")
				}
			}
			if c.idleNeverRecovers != "" || c.reapply == nil {
				return
			}
			c.reapply(t, a)
			if !a.Healthy() {
				t.Error("the same inbound pushed again did not bring it back")
			}
			if p, ok := a.(core.Provisionable); ok && !p.Provisioned() {
				t.Error("the same inbound pushed again and Provisioned still says no")
			}
		})
	}
}

// A row that is not asked to recover from Idle must say why.
func TestEveryRowEitherRecoversFromIdleOrSaysWhy(t *testing.T) {
	for _, c := range cases() {
		if c.idleNeverRecovers == "" && c.reapply == nil {
			t.Errorf("%s: no reapply and no idleNeverRecovers reason; Idle recovery is neither asked nor excused", c.name)
		}
	}
}

// coreSources reads the non-test Go sources of the subdirectories of internal/core (the package under
// test is the working directory) as the adapter and process scans see them.
func coreSources(t *testing.T) map[string]map[string]string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read the core package dir: %v", err)
	}
	out := map[string]map[string]string{}
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
			if out[e.Name()] == nil {
				out[e.Name()] = map[string]string{}
			}
			out[e.Name()][f.Name()] = string(src)
		}
	}
	return out
}

// The control on the list itself: an adapter is any subdirectory that declares
// `func (a *Adapter) Start(`. A contract test that covers a third of its
// subject reads exactly like one that covers all of it, so the table is
// checked against the packages on disk. Subdirectories that are not adapters:
// subprocess (the supervisor every owner uses).
func TestEveryAdapterIsInTheContract(t *testing.T) {
	var onDisk []string
	for dir, files := range coreSources(t) {
		for _, src := range files {
			if strings.Contains(src, "func (a *Adapter) Start(") {
				onDisk = append(onDisk, dir)
				break
			}
		}
	}
	sort.Strings(onDisk)
	// An empty scan would make the comparison vacuous; "found nothing" is also
	// what a moved package or a renamed method looks like.
	if len(onDisk) < 6 {
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
		t.Errorf("these adapters implement Start and are not compared against the lifecycle: %v\n"+
			"      Add a row to cases(). An adapter outside this file is one whose Start, Stop,\n"+
			"      Healthy and Provisioned agree with nothing.", missing)
	}
	// A row whose package is gone would keep passing against a fixture nobody
	// ships. (singbox's adapter is named after its protocol at run time, so
	// the row is by package.)
	onDiskSet := map[string]bool{}
	for _, d := range onDisk {
		onDiskSet[d] = true
	}
	for name := range covered {
		if !onDiskSet[name] {
			t.Errorf("row %q has no adapter package behind it any more", name)
		}
	}
}

// subprocessLiterals returns, by "<dir>/<file>", the body of every
// `subprocess.New(subprocess.Config{ ... })` literal in non-test sources of
// internal/core, by brace matching.
func subprocessLiterals(t *testing.T) map[string][]string {
	t.Helper()
	const opener = "subprocess.New(subprocess.Config{"
	out := map[string][]string{}
	for dir, files := range coreSources(t) {
		for name, src := range files {
			rest := src
			for {
				at := strings.Index(rest, opener)
				if at < 0 {
					break
				}
				body := rest[at+len(opener):]
				depth, end := 1, -1
				for i := 0; i < len(body) && end < 0; i++ {
					switch body[i] {
					case '{':
						depth++
					case '}':
						depth--
						if depth == 0 {
							end = i
						}
					}
				}
				if end < 0 {
					t.Fatalf("%s/%s: unterminated subprocess.Config literal", dir, name)
				}
				out[dir+"/"+name] = append(out[dir+"/"+name], body[:end])
				rest = body[end:]
			}
		}
	}
	return out
}

// subprocessOwners: the adapter packages with a subprocess.Config literal.
func subprocessOwners(t *testing.T) map[string]bool {
	t.Helper()
	owners := map[string]bool{}
	for key := range subprocessLiterals(t) {
		owners[strings.SplitN(key, "/", 2)[0]] = true
	}
	// The control: no literals found means the constructor was renamed and
	// every check built on this is empty.
	if len(owners) < 6 {
		t.Fatalf("only %d packages own a subprocess.Config literal (%v); the scan stopped matching", len(owners), owners)
	}
	return owners
}

// ownersInTheTable returns the case of each process owner, failing for one the
// table does not have (TestEveryAdapterIsInTheContract says it first and says
// more; this keeps the owner checks from skipping it quietly).
func ownersInTheTable(t *testing.T) []adapterCase {
	t.Helper()
	owners := subprocessOwners(t)
	var out []adapterCase
	have := map[string]bool{}
	for _, c := range cases() {
		if owners[c.name] {
			out = append(out, c)
			have[c.name] = true
		}
	}
	for name := range owners {
		if !have[name] {
			t.Errorf("%s owns a subprocess and has no row in the contract", name)
		}
	}
	return out
}

// Owning a process means being able to say why it died: core.FaultReporter is
// optional, and an absent optional interface looks exactly like a core that
// had nothing to report.
func TestEveryAdapterThatOwnsAProcessSaysWhyItDied(t *testing.T) {
	var silent []string
	for _, c := range ownersInTheTable(t) {
		a, _ := c.build(t, true)
		t.Cleanup(func() { _ = a.Stop(context.Background()) })
		if _, ok := a.(core.FaultReporter); !ok {
			silent = append(silent, c.name)
		}
	}
	sort.Strings(silent)
	if len(silent) > 0 {
		t.Errorf("these adapters own a process and cannot say why it died: %v\n"+
			"      Implement core.FaultReporter (Fault() in report.go).", silent)
	}
}

// Owning a process also means counting how often it was restarted: a restart
// that succeeds keeps the node online, so nothing else tells the operator that
// every live connection was dropped.
func TestEveryAdapterThatOwnsAProcessCountsItsRestarts(t *testing.T) {
	var silent []string
	for _, c := range ownersInTheTable(t) {
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
// has not crashed. Every subprocess.Config literal names OnRestart.
func TestEverySupervisedCoreSubscribesToItsOwnRestarts(t *testing.T) {
	literals := subprocessLiterals(t)
	var missing []string
	found := 0
	for key, bodies := range literals {
		for _, body := range bodies {
			found++
			if !strings.Contains(body, "OnRestart:") {
				missing = append(missing, key)
			}
		}
	}
	if found < 6 {
		t.Fatalf("only %d subprocess.Config literals found; the scan stopped matching", found)
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("these spawn a supervised core and never hear that it restarted: %v", missing)
	}
}
