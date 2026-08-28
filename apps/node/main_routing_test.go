package main

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// buildAdapters is the node's routing table, and until now nothing read it.
//
// A pushed inbound reaches an adapter only if some registered adapter answers
// to BOTH its protocol and its resolved engine. When none does, nothing fails:
// the handler logs "no adapter for protocol/engine, config persisted but not
// applied live", counts the inbound as skipped, and answers 200. The node stays
// green, /healthz stays green, and that protocol serves nobody. It has happened
// twice already — amneziawg (cycle #6) and naive (cycle #8) each shipped a
// finished adapter that was never added to this list.
//
// The set of pairs the panel can produce is not written down here. It is read
// out of the panel's own sources: the protocol union in transport.ts (which
// dto.ProtocolName says it mirrors) and ENGINE_OPTIONS in profiles.schemas.ts,
// which is what the API validates a profile against. A protocol added there
// with no adapter on this side fails here rather than on a node.

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "packages", "shared", "src", "transport.ts")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("could not find the repository root above the node module; the panel's protocol list cannot be read")
	return ""
}

// panelProtocols reads the ProtocolName union out of transport.ts.
func panelProtocols(t *testing.T) []string {
	t.Helper()
	src, err := os.ReadFile(filepath.Join(repoRoot(t), "packages", "shared", "src", "transport.ts"))
	if err != nil {
		t.Fatalf("read transport.ts: %v", err)
	}
	i := strings.Index(string(src), "export type ProtocolName =")
	if i < 0 {
		t.Fatal("ProtocolName union was renamed or moved in transport.ts")
	}
	body := string(src)[i:]
	body = body[:strings.Index(body, ";")]
	out := regexp.MustCompile(`'([a-z0-9]+)'`).FindAllStringSubmatch(body, -1)
	var names []string
	for _, m := range out {
		names = append(names, m[1])
	}
	if len(names) < 8 {
		t.Fatalf("only %d protocols parsed out of transport.ts (%v); the union's shape changed and every case below would be nearly empty", len(names), names)
	}
	return names
}

// panelEngineOptions reads ENGINE_OPTIONS out of the profile schema: the map
// the API validates `engine` against, so exactly the non-native pairs a profile
// can be saved with.
func panelEngineOptions(t *testing.T) map[string][]string {
	t.Helper()
	src, err := os.ReadFile(filepath.Join(repoRoot(t),
		"apps", "panel-backend", "src", "modules", "profiles", "profiles.schemas.ts"))
	if err != nil {
		t.Fatalf("read profiles.schemas.ts: %v", err)
	}
	i := strings.Index(string(src), "const ENGINE_OPTIONS")
	if i < 0 {
		t.Fatal("ENGINE_OPTIONS was renamed or moved in profiles.schemas.ts")
	}
	body := string(src)[i:]
	body = body[:strings.Index(body, "};")]
	opts := map[string][]string{}
	for _, line := range regexp.MustCompile(`(?m)^\s*([a-z0-9]+):\s*\[([^\]]*)\]`).FindAllStringSubmatch(body, -1) {
		var engines []string
		for _, e := range regexp.MustCompile(`'([a-z0-9]+)'`).FindAllStringSubmatch(line[2], -1) {
			engines = append(engines, e[1])
		}
		opts[line[1]] = engines
	}
	if len(opts) == 0 {
		t.Fatal("no protocol->engines entries parsed out of ENGINE_OPTIONS")
	}
	return opts
}

// fullyEquippedNode sets every binary the registry gates on, so the registry
// under test is the biggest one a node can have. Fake files are enough: nothing
// here starts a core, and the two probes that stat a path (awg, caddy-naive)
// only ask whether it is there.
func fullyEquippedNode(t *testing.T) {
	t.Helper()
	bin := t.TempDir()
	touch := func(name string) string {
		p := filepath.Join(bin, name)
		if err := os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatalf("stub %s: %v", name, err)
		}
		return p
	}
	for k, v := range map[string]string{
		"XRAY_BINARY":         touch("xray"),
		"MTG_BINARY":          touch("mtg"),
		"MITA_BINARY":         touch("mita"),
		"SINGBOX_BINARY":      touch("sing-box"),
		"AMNEZIAWG_BIN":       touch("awg"),
		"AMNEZIAWG_QUICK_BIN": touch("awg-quick"),
		"WIREGUARD_BIN":       touch("wg"),
		"WIREGUARD_QUICK_BIN": touch("wg-quick"),
		"CADDY_NAIVE_BIN":     touch("caddy-naive"),
		"HYSTERIA_BINARY":     touch("hysteria"),
	} {
		t.Setenv(k, v)
	}
}

func TestEveryPairThePanelCanSendHasAnAdapter(t *testing.T) {
	fullyEquippedNode(t)
	adapters := buildAdapters(silentLogger())

	// Control: a registry that came back empty would satisfy nothing below by
	// failing loudly, but a registry with one adapter would quietly satisfy
	// only the hysteria cases. Say how big it is.
	if len(adapters) < 10 {
		t.Fatalf("a node with every binary present registered only %d adapters: %v",
			len(adapters), adapterKeys(adapters))
	}

	var missing []string
	for _, p := range panelProtocols(t) {
		// engine unset is the ordinary case and the only one pre-engine-choice
		// inbounds can be; it resolves through the node's own NativeEngine.
		want := string(dto.NativeEngine(dto.ProtocolName(p)))
		if core.MatchAdapter(adapters, p, want) == nil {
			missing = append(missing, core.AdapterKey(p, want)+" (engine unset)")
		}
	}
	for p, engines := range panelEngineOptions(t) {
		for _, e := range engines {
			if core.MatchAdapter(adapters, p, e) == nil {
				missing = append(missing, core.AdapterKey(p, e)+" (engine pinned)")
			}
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		t.Errorf("the panel can save profiles no adapter on this node answers to:\n  %s\nregistered: %v",
			strings.Join(missing, "\n  "), adapterKeys(adapters))
	}
}

func TestNoTwoAdaptersClaimTheSamePair(t *testing.T) {
	fullyEquippedNode(t)
	adapters := buildAdapters(silentLogger())

	// The dispatcher takes the FIRST match, and the deletion reconciler keys
	// the keep-list by the same pair. Two adapters on one pair means the second
	// never receives an inbound but is still handed the list of ids to keep —
	// so it would drop everything it holds on the next push.
	seen := map[string]string{}
	for _, a := range adapters {
		key := core.AdapterKey(a.Name(), a.Engine())
		if prev, dup := seen[key]; dup {
			t.Errorf("%s is claimed twice (%s and %s)", key, prev, a.Name())
		}
		seen[key] = a.Name()
	}
}

func TestABareNodeRegistersOnlyWhatItHas(t *testing.T) {
	// The other end of the same table. Every optional core is gated on a binary,
	// and a gate that let an adapter through anyway would give the node an
	// adapter for a core it cannot run: the inbound would be dispatched, the
	// adapter would fail to start it, and the failure would be reported as the
	// panel's push failing rather than as this node lacking the binary.
	for _, k := range []string{
		"XRAY_BINARY", "MTG_BINARY", "MITA_BINARY", "SINGBOX_BINARY",
		"HYSTERIA_BINARY",
	} {
		t.Setenv(k, "")
	}
	missing := filepath.Join(t.TempDir(), "not-installed")
	for _, k := range []string{"AMNEZIAWG_BIN", "WIREGUARD_BIN", "CADDY_NAIVE_BIN"} {
		t.Setenv(k, missing)
	}

	adapters := buildAdapters(silentLogger())
	got := adapterKeys(adapters)
	// Nothing. hysteria used to be here, registered unconditionally, and this
	// test said why: "its adapter runs the auth callback server, which the
	// panel needs even before a binary is installed." That reason does not
	// survive being looked at — the callback exists for hysteria-server to
	// authenticate users against, and without a hysteria binary there is no
	// hysteria-server to call it. What it produced instead was measured from
	// the panel on a real VM (2026-08-28): a node installed with --protocol
	// tuic reported `hysteria running: true, version: null` in
	// GET /api/nodes/:id/cores, because Healthy() for that adapter IS the
	// callback server. A green card over a protocol the node cannot serve.
	if len(got) != 0 {
		t.Errorf("a node with no cores installed registered %v, want nothing", got)
	}
}

func TestHysteriaIsRegisteredForEitherWayItRuns(t *testing.T) {
	// The control on the case above: gating it must not make it unreachable.
	// A node runs hysteria as a child process (HYSTERIA_BINARY) or as the
	// systemd unit the installer wrote (HYSTERIA_SERVICE_UNIT), and the
	// installer sets both together — but an operator hand-managing the unit
	// has only the second, so both have to count.
	for _, tc := range []struct{ name, key, value string }{
		{"as a child process", "HYSTERIA_BINARY", "/usr/local/bin/hysteria"},
		{"as a systemd unit", "HYSTERIA_SERVICE_UNIT", "hysteria"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, k := range []string{
				"XRAY_BINARY", "MTG_BINARY", "MITA_BINARY", "SINGBOX_BINARY",
				"HYSTERIA_BINARY", "HYSTERIA_SERVICE_UNIT",
			} {
				t.Setenv(k, "")
			}
			missing := filepath.Join(t.TempDir(), "not-installed")
			for _, k := range []string{"AMNEZIAWG_BIN", "WIREGUARD_BIN", "CADDY_NAIVE_BIN"} {
				t.Setenv(k, missing)
			}
			t.Setenv(tc.key, tc.value)

			got := adapterKeys(buildAdapters(silentLogger()))
			want := []string{core.AdapterKey("hysteria", "hysteria")}
			if strings.Join(got, ",") != strings.Join(want, ",") {
				t.Errorf("with %s set the node registered %v, want %v", tc.key, got, want)
			}
		})
	}
}

// The package already has a quietLogger that also hands back its buffer; this
// one just discards, because nothing here reads the log.
func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func adapterKeys(adapters []core.CoreAdapter) []string {
	keys := make([]string, 0, len(adapters))
	for _, a := range adapters {
		keys = append(keys, core.AdapterKey(a.Name(), a.Engine()))
	}
	return keys
}
