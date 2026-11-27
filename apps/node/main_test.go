package main

import (
	"io"
	"log/slog"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// An agent with NO engine configured still names every engine it knows, each
// as not installed. Before core.Absent, such a node reported only hysteria (the
// one adapter registered unconditionally), and "not installed" read the same as
// "never mentioned" on the node card.
func TestAnAgentWithNothingConfiguredReportsNineEnginesAllAbsent(t *testing.T) {
	for _, k := range []string{"XRAY_BINARY", "SINGBOX_BINARY", "HYSTERIA_BINARY", "MTG_BINARY", "MTPROTOPROXY_SCRIPT", "MITA_BINARY"} {
		t.Setenv(k, "")
	}
	// These two are probed by path with a default, so point them at nothing.
	nowhere := t.TempDir()
	t.Setenv("AMNEZIAWG_BIN", filepath.Join(nowhere, "awg"))
	t.Setenv("CADDY_NAIVE_BIN", filepath.Join(nowhere, "caddy-naive"))
	t.Setenv("WIREGUARD_BIN", "")

	adapters := buildAdapters(slog.New(slog.NewTextHandler(io.Discard, nil)))

	var engines []string
	for _, a := range adapters {
		engines = append(engines, a.Engine())
		inst, ok := a.(core.Installable)
		if !ok || inst.Installed() {
			t.Errorf("%s/%s: want installed:false, reported installable=%v", a.Name(), a.Engine(), ok)
		}
		// Idle, not down: a node whose engines are all absent must not read
		// as degraded because of them. hysteria is its own adapter here, in
		// callback-only mode, and answers for itself as it always has.
		if !core.IsAbsent(a) {
			continue
		}
		if p, ok := a.(core.Provisionable); !ok || p.Provisioned() {
			t.Errorf("%s/%s: an absent engine must say it is not provisioned", a.Name(), a.Engine())
		}
	}
	sort.Strings(engines)
	want := "amneziawg hysteria mieru mtproto mtprotoproxy naive singbox wireguard xray"
	if got := strings.Join(engines, " "); got != want {
		t.Fatalf("engines = %q, want exactly one row per known engine: %q", got, want)
	}
}

// Every real core answers its version, so the node card shows one for each
// engine and not only for xray (until 2026-09-23 xray was the one Versioner).
// A stand-in for a missing engine does not: there is no binary to ask.
func TestEveryRealCoreAnswersItsVersion(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	t.Setenv("XRAY_BINARY", "/nonexistent/xray")
	t.Setenv("SINGBOX_BINARY", "/nonexistent/sing-box")
	t.Setenv("MTG_BINARY", "/nonexistent/mtg")
	t.Setenv("MTPROTOPROXY_SCRIPT", "/nonexistent/mtprotoproxy.py")
	t.Setenv("MITA_BINARY", "/nonexistent/mita")
	for _, a := range buildAdapters(logger) {
		_, versioned := a.(core.Versioner)
		if core.IsAbsent(a) {
			if versioned {
				t.Errorf("%s/%s: a stand-in answers a version", a.Name(), a.Engine())
			}
			continue
		}
		if !versioned {
			t.Errorf("%s/%s answers no version", a.Name(), a.Engine())
		}
	}
}

// A registered engine keeps its own adapters and gets no stand-in beside it: a
// second row for the same engine would say "installed" and "not installed" at
// once.
func TestARegisteredEngineGetsNoStandIn(t *testing.T) {
	registered := []core.CoreAdapter{core.NewAbsent("xray", "xray")}
	out := withAbsentEngines(registered)
	count := 0
	for _, a := range out {
		if a.Engine() == "xray" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("xray appears %d times, want 1", count)
	}
	if len(out) != len(knownEngines) {
		t.Fatalf("got %d rows, want %d", len(out), len(knownEngines))
	}
}

// Plain WireGuard (milestone 9.1) is registered by an explicit WIREGUARD_BIN
// and by nothing else: wireguard-tools is on every AWG node (its bootstrap
// installs it), so the presence of /usr/bin/wg says nothing about whether an
// operator asked for the engine. Without the variable the engine is the
// absent stand-in of knownEngines, one row per known engine; with it the
// adapter takes the stand-in's place.
func TestWireguardIsRegisteredOnlyByAnExplicitBin(t *testing.T) {
	for _, k := range []string{"XRAY_BINARY", "SINGBOX_BINARY", "HYSTERIA_BINARY", "MTG_BINARY", "MTPROTOPROXY_SCRIPT", "MITA_BINARY"} {
		t.Setenv(k, "")
	}
	nowhere := t.TempDir()
	t.Setenv("AMNEZIAWG_BIN", filepath.Join(nowhere, "awg"))
	t.Setenv("CADDY_NAIVE_BIN", filepath.Join(nowhere, "caddy-naive"))
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	t.Setenv("WIREGUARD_BIN", "")
	for _, a := range buildAdapters(logger) {
		if (a.Name() == "wireguard" || a.Engine() == "wireguard") && !core.IsAbsent(a) {
			t.Fatalf("a wireguard adapter without WIREGUARD_BIN: %s/%s", a.Name(), a.Engine())
		}
	}

	// With the variable: the adapter in place of the stand-in.
	t.Setenv("WIREGUARD_BIN", filepath.Join(nowhere, "wg"))
	t.Setenv("WIREGUARD_INTERFACE", "wg7")
	var found core.CoreAdapter
	n := 0
	for _, a := range buildAdapters(logger) {
		n++
		if a.Name() == "wireguard" || a.Engine() == "wireguard" {
			found = a
		}
	}
	if found == nil {
		t.Fatal("WIREGUARD_BIN is set and no wireguard adapter is registered")
	}
	if core.IsAbsent(found) {
		t.Error("WIREGUARD_BIN is set and the wireguard row is still the absent stand-in")
	}
	if found.Engine() != "wireguard" {
		t.Errorf("engine = %q", found.Engine())
	}
	if n != len(knownEngines) {
		t.Errorf("%d adapters, want one per known engine (%d), the wireguard adapter in place of its stand-in", n, len(knownEngines))
	}
	// Not installed: the file is not there, and Installed says so.
	if inst, ok := found.(core.Installable); !ok || inst.Installed() {
		t.Errorf("a wg binary that is not on the machine reads as installed")
	}
}

// The API listens where the host allows, and an explicit NODE_HOST wins over
// whatever the host would have chosen.
func TestNodeHostDefaultAndExplicit(t *testing.T) {
	t.Setenv("NODE_HOST", "")
	if got, want := nodeHost(), core.ListenAddr(); got != want {
		t.Errorf("default NODE_HOST = %q, want %q", got, want)
	}
	for _, v := range []string{"0.0.0.0", "10.1.2.3", "::1"} {
		t.Setenv("NODE_HOST", v)
		if got := nodeHost(); got != v {
			t.Errorf("NODE_HOST=%q: got %q", v, got)
		}
	}
}
