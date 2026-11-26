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
func TestAnAgentWithNothingConfiguredReportsEightEnginesAllAbsent(t *testing.T) {
	for _, k := range []string{"XRAY_BINARY", "SINGBOX_BINARY", "HYSTERIA_BINARY", "MTG_BINARY", "MTPROTOPROXY_SCRIPT", "MITA_BINARY"} {
		t.Setenv(k, "")
	}
	// These two are probed by path with a default, so point them at nothing.
	nowhere := t.TempDir()
	t.Setenv("AMNEZIAWG_BIN", filepath.Join(nowhere, "awg"))
	t.Setenv("CADDY_NAIVE_BIN", filepath.Join(nowhere, "caddy-naive"))

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
	want := "amneziawg hysteria mieru mtproto mtprotoproxy naive singbox xray"
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
// operator asked for the engine. Without the variable the adapter list is the
// base's, one row per known engine.
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
		if a.Name() == "wireguard" || a.Engine() == "wireguard" {
			t.Fatalf("a wireguard adapter without WIREGUARD_BIN: %s/%s", a.Name(), a.Engine())
		}
	}

	// With the variable: one more adapter, on wg0, and no stand-in or row for
	// the engine in knownEngines (the node reports it only when asked to run
	// it; the name joins the shared lists in 9.3).
	t.Setenv("WIREGUARD_BIN", filepath.Join(nowhere, "wg"))
	t.Setenv("WIREGUARD_INTERFACE", "wg7")
	var found core.CoreAdapter
	n := 0
	for _, a := range buildAdapters(logger) {
		n++
		if a.Name() == "wireguard" {
			found = a
		}
	}
	if found == nil {
		t.Fatal("WIREGUARD_BIN is set and no wireguard adapter is registered")
	}
	if found.Engine() != "wireguard" {
		t.Errorf("engine = %q", found.Engine())
	}
	if n != len(knownEngines)+1 {
		t.Errorf("%d adapters, want the %d known engines and the wireguard one", n, len(knownEngines))
	}
	for _, k := range knownEngines {
		if k.engine == "wireguard" || k.protocol == "wireguard" {
			t.Errorf("knownEngines names wireguard: %+v (milestone 9.3 adds it)", k)
		}
	}
	// Not installed: the file is not there, and Installed says so.
	if inst, ok := found.(core.Installable); !ok || inst.Installed() {
		t.Errorf("a wg binary that is not on the machine reads as installed")
	}
}
