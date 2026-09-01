package core_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/hysteria"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/mieru"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/mtproto"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/shadowsocks"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/singbox"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/xray"
)

// "Which version of its binary is this core running", asked of all eight.
//
// One adapter answered it — xray — so the panel could tell an operator what an
// xray node ran and nothing about any other. That mattered little while the
// binaries came from GitHub and nobody knew what they should be; it matters now
// that the panel PINS a version and carries the artefact, because "what this
// node runs" and "what the panel pinned" are two numbers that can differ, and
// the difference is the whole point of showing either.
//
// Two adapters are outside this and each says why rather than being quietly
// absent — the shape that let sing-box sit outside the lifecycle contract while
// it had drifted:
//
//   - amneziawg has no binary of its own to ask. It drives awg-quick and the
//     kernel module, and neither has a version this panel pins.
//   - naive's core is a Caddy compiled on the node by xcaddy, so its version is
//     whatever that build produced. The panel carries no artefact for it and
//     therefore has nothing to compare an answer against.
//
// Both are also the two adapters with no injectable command runner, which is
// the same fact from the other side.

// The exact bytes each pinned binary prints, captured by running it —
// sing-box 1.13.19, mtg 2.2.8, hysteria 2.12.2, mita 3.36.0 and xray 26.3.27,
// the artefacts packages/shared/src/core-binaries.ts pins. This is the evidence
// for `ParseSemverish`'s "the first x.y.z is the version" rule: it is read off
// these, not assumed, and an upstream that changes its format has to be
// re-measured here before the parser can be trusted again.
const (
	singboxOut = "sing-box version 1.13.19\n\n" +
		"Environment: go1.24.0 linux/amd64\n" +
		"Tags: with_gvisor,with_quic,with_dhcp,with_wireguard\n" +
		"Revision: eb07c7a79eeca943370eafea601e87da76c0e57e\n" +
		"CGO: enabled\n"
	mtgOut = "2.2.8 (go1.26.1: 2026-04-07T16:10:41Z on " +
		"83a31e04585aa7d9249cf5118a7a418c809ada5f, modules checksum V78O7Ljjkr)\n"
	// The banner really is the first thing hysteria prints, and it carries no
	// digits, which is why the first triple in the whole output is the version.
	hysteriaOut = "\n░█░█░█░█░█▀▀░▀█▀░█▀▀░█▀▄░▀█▀░█▀█░░░▀▀▄\n" +
		"a powerful, lightning fast and censorship resistant proxy\n" +
		"Aperture Internet Laboratory <https://github.com/apernet>\n\n" +
		"Version:\tv2.12.2\nBuildDate:\t2026-08-23T00:39:00Z\nBuildType:\trelease\n" +
		"Toolchain:\tgo1.26.6 linux/amd64\n"
	mitaOut = "3.36.0\n"
	xrayOut = "Xray 26.3.27 (Xray, Penetrates Everything.) d2758a0 (go1.26.1 linux/amd64)\n" +
		"A unified platform for anti-censorship.\n"
)

type versionCase struct {
	name string
	want string
	// build returns an adapter whose runner answers `out`. `bin` empty puts the
	// adapter in config-only mode, which is how every one of them runs before
	// the panel has pushed anything and on a node whose binary is missing.
	build func(t *testing.T, bin, out string, seen *[]string) core.CoreAdapter
}

func versionCases() []versionCase {
	run := func(out string, seen *[]string) func(context.Context, string, ...string) ([]byte, error) {
		return func(_ context.Context, _ string, args ...string) ([]byte, error) {
			*seen = append(*seen, args...)
			return []byte(out), nil
		}
	}
	return []versionCase{
		{
			name: "sing-box", want: "1.13.19",
			build: func(t *testing.T, bin, out string, seen *[]string) core.CoreAdapter {
				return singbox.New(singbox.Config{
					Protocol: "tuic", BinaryPath: bin,
					ConfigPath: filepath.Join(t.TempDir(), "c.json"),
					RunCmd:     run(out, seen),
				}, quiet())
			},
		},
		{
			name: "mtg", want: "2.2.8",
			build: func(t *testing.T, bin, out string, seen *[]string) core.CoreAdapter {
				return mtproto.New(mtproto.Config{
					BinaryPath: bin,
					ConfigPath: filepath.Join(t.TempDir(), "c.toml"),
					RunCmd:     run(out, seen),
				}, quiet())
			},
		},
		{
			name: "hysteria", want: "2.12.2",
			build: func(t *testing.T, bin, out string, seen *[]string) core.CoreAdapter {
				return hysteria.New(hysteria.Config{
					BinaryPath: bin,
					RunOutput:  run(out, seen),
				}, quiet())
			},
		},
		{
			name: "mita", want: "3.36.0",
			build: func(t *testing.T, bin, out string, seen *[]string) core.CoreAdapter {
				return mieru.New(mieru.Config{
					BinaryPath: bin,
					ConfigPath: filepath.Join(t.TempDir(), "s.json"),
					RunCmd:     run(out, seen),
				}, quiet())
			},
		},
		{
			// Shares the xray binary, so it reports xray's version.
			name: "shadowsocks", want: "26.3.27",
			build: func(t *testing.T, bin, out string, seen *[]string) core.CoreAdapter {
				return shadowsocks.New(shadowsocks.Config{
					BinaryPath: bin,
					ConfigPath: filepath.Join(t.TempDir(), "ss.json"),
					RunCmd:     run(out, seen),
				}, quiet())
			},
		},
		{
			name: "xray", want: "26.3.27",
			build: func(t *testing.T, bin, out string, seen *[]string) core.CoreAdapter {
				return xray.New(xray.Config{
					BinaryPath: bin,
					ConfigPath: filepath.Join(t.TempDir(), "c.json"),
					RunCmd:     run(out, seen),
				}, quiet())
			},
		},
	}
}

func outFor(name string) string {
	switch name {
	case "sing-box":
		return singboxOut
	case "mtg":
		return mtgOut
	case "hysteria":
		return hysteriaOut
	case "mita":
		return mitaOut
	default:
		return xrayOut
	}
}

func TestEveryBinaryOwningAdapterReportsItsVersion(t *testing.T) {
	for _, c := range versionCases() {
		t.Run(c.name, func(t *testing.T) {
			var seen []string
			a := c.build(t, "/usr/local/bin/core", outFor(c.name), &seen)
			v, ok := a.(core.Versioner)
			if !ok {
				t.Fatalf("%s does not implement core.Versioner, so the panel cannot show what it runs", c.name)
			}
			if got := v.CoreVersion(); got != c.want {
				t.Errorf("read %q out of the binary's real output, want %q", got, c.want)
			}
			if len(seen) == 0 {
				t.Fatal("the binary was never asked; the version above came from somewhere else")
			}
		})
	}
}

func TestTheVersionIsAskedOnceAndKept(t *testing.T) {
	// /healthz calls this on every poll, every 30 seconds, for every core on
	// the node. Forking a process each time is the cost the cache exists to
	// avoid, and a cache nobody checks is a cache that quietly is not one.
	for _, c := range versionCases() {
		t.Run(c.name, func(t *testing.T) {
			var seen []string
			a := c.build(t, "/usr/local/bin/core", outFor(c.name), &seen)
			v := a.(core.Versioner)
			first := v.CoreVersion()
			calls := len(seen)
			for i := 0; i < 5; i++ {
				if got := v.CoreVersion(); got != first {
					t.Fatalf("answer %d differs: %q then %q", i, first, got)
				}
			}
			if len(seen) != calls {
				t.Errorf("the binary was asked %d more times after the first answer", len(seen)-calls)
			}
		})
	}
}

func TestAnAdapterWithNoBinaryReportsNothingRatherThanGuessing(t *testing.T) {
	// Config-only mode: no binary to ask. "" is the honest answer, and it has
	// to come WITHOUT running anything — a version query that shells out at a
	// path that does not exist is a fork per healthcheck on every node that has
	// not been pushed an inbound yet.
	for _, c := range versionCases() {
		t.Run(c.name, func(t *testing.T) {
			var seen []string
			a := c.build(t, "", outFor(c.name), &seen)
			if got := a.(core.Versioner).CoreVersion(); got != "" {
				t.Errorf("with no binary configured it answered %q", got)
			}
			if len(seen) != 0 {
				t.Errorf("with no binary configured it still ran something: %v", seen)
			}
		})
	}
}

func TestOutputWithNoVersionInItYieldsNothing(t *testing.T) {
	// A binary that answers an error string, or a build whose format moved.
	// Anything invented here reaches the panel as a version that may agree with
	// the pin while nothing was actually read.
	for _, c := range versionCases() {
		t.Run(c.name, func(t *testing.T) {
			var seen []string
			a := c.build(t, "/usr/local/bin/core", "command not found\n", &seen)
			if got := a.(core.Versioner).CoreVersion(); got != "" {
				t.Errorf("invented %q from output that carries no version", got)
			}
		})
	}
}

func TestTheAdaptersOutsideThisContractAreNamed(t *testing.T) {
	// The control on the list, same as the lifecycle contract's: an adapter
	// that owns a binary and is not compared here is one whose version the
	// panel silently cannot show.
	covered := map[string]bool{}
	for _, c := range versionCases() {
		covered[c.name] = true
	}
	// Spelled by ADAPTER name, which is how cases() names them.
	byAdapter := map[string]string{
		"singbox": "sing-box", "mtproto": "mtg", "hysteria": "hysteria",
		"mieru": "mita", "shadowsocks": "shadowsocks", "xray": "xray",
	}
	exempt := map[string]string{
		"amneziawg": "drives awg-quick and the kernel module; no binary of its own to ask",
		"naive":     "its Caddy is compiled on the node by xcaddy; the panel pins no artefact to compare against",
		"mtprotoproxy": "upstream ships no version string at all — no --version, no __version__. " +
			"Reporting the PYTHON version instead would be worse than reporting nothing, because " +
			"the panel would show a number that looks like the proxy's and is not.",
	}
	var missing []string
	for _, c := range cases() {
		if _, ok := exempt[c.name]; ok {
			continue
		}
		want, known := byAdapter[c.name]
		if !known || !covered[want] {
			missing = append(missing, c.name)
		}
	}
	if len(missing) > 0 {
		t.Errorf("these adapters own a binary and are not asked for its version: %v\n"+
			"      Add a case to versionCases(), or name it in `exempt` with the reason.", missing)
	}
	if len(cases()) < 8 {
		t.Fatalf("only %d adapters found; this comparison is emptier than it looks", len(cases()))
	}
}
