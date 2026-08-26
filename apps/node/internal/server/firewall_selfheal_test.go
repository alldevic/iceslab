package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
	"github.com/icecompany-tech/iceslab/apps/node/internal/payload"
)

// `ensureFirewallFromStore` is the firewall's self-healing on boot: the
// applyInbounds handler opens ports when a push lands, and this re-opens them
// for every persisted inbound at startup, so a node that reboots (or whose ufw
// rule was lost to a reimage, or to an `ufw allow` that failed with no retry)
// does not run its cores behind a closed firewall until the panel happens to
// push again. When it breaks, the cores come up, the agent reports healthy,
// the panel is green, and clients simply cannot connect.
//
// §41.4 recorded this function as covered. It was not: `go test -coverpkg`
// still reports 0.0% for it, while its two callees sit at 60% and 55.6% —
// they are reached through applyInbounds, and nothing ever went in through
// this door. The note is corrected in the docs along with this file.
//
// WHAT THIS CAN AND CANNOT SEE, stated because the difference matters: the
// port is opened by `firewall.Allow`, which shells out to `ufw`, and there is
// no seam to substitute it. On a host without ufw it returns quietly, so
// "the port ended up open" is NOT observable here. What is observable is the
// decision this function makes — whether it read the store at all, and how
// many inbounds it handed on — and that is what each case below asserts. A
// test that claimed to check the firewall would be claiming more than it does.

func newServerForStore(t *testing.T, storePath string, log *strings.Builder) *Server {
	t.Helper()
	var w io.Writer = io.Discard
	if log != nil {
		w = log
	}
	srv, err := New(Config{
		Logger:            slog.New(slog.NewTextHandler(w, nil)),
		Payload:           &payload.Payload{NodeCertPem: "x", NodeKeyPem: "y", CACertPem: "z"},
		InboundsStorePath: storePath,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return srv
}

func writeStore(t *testing.T, inbounds []dto.InboundDto) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "inbounds.json")
	blob, err := json.Marshal(inbounds)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if err := os.WriteFile(path, blob, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

func TestEnsureFirewallFromStore_ReadsEveryPersistedInbound(t *testing.T) {
	var log strings.Builder
	srv := newServerForStore(t, writeStore(t, []dto.InboundDto{
		{ID: "a", Protocol: dto.ProtocolXray, Port: 443},
		{ID: "b", Protocol: "hysteria", Port: 8443},
		{ID: "c", Protocol: "shadowsocks", Port: 9000},
	}), &log)

	srv.ensureFirewallFromStore(context.Background())

	out := log.String()
	if !strings.Contains(out, "re-ensured firewall for persisted inbounds") {
		t.Fatalf("the store was never processed; log said:\n%s", out)
	}
	// The count is the only number this function reports, and it is what says
	// whether the whole set was handed on or only part of it.
	if !strings.Contains(out, "count=3") {
		t.Errorf("expected all three persisted inbounds to be re-ensured; log said:\n%s", out)
	}
}

// The count above is computed from `len(inbounds)` and printed AFTER the loop,
// so it says the store was read — not that anything was handed on. Measured:
// emptying the loop (`range inbounds[:0]`) leaves that line untouched and the
// case above green. This one goes through the callee instead.
//
// `ensureInboundFirewall` warns on a port-0 inbound (a legacy push, whose rule
// it deliberately does not open), and that warning is only reachable from
// inside the loop. So a store holding one is the smallest fixture in which
// "each inbound was actually passed on" is visible on a host with no ufw.
func TestEnsureFirewallFromStore_PassesEachInboundOn(t *testing.T) {
	var log strings.Builder
	srv := newServerForStore(t, writeStore(t, []dto.InboundDto{
		{ID: "legacy", Protocol: dto.ProtocolXray, Port: 0},
	}), &log)

	srv.ensureFirewallFromStore(context.Background())

	if !strings.Contains(log.String(), "firewall rule NOT opened automatically") {
		t.Errorf("the persisted inbound never reached ensureInboundFirewall, so nothing was "+
			"re-opened on boot and the node runs behind a closed firewall until the panel "+
			"pushes again; log said:\n%s", log.String())
	}
}

// A fresh node has no store yet, and a node whose store is corrupt must still
// boot. Neither may take the agent down — but the corrupt one must SAY so,
// because it is the case where ports silently stay shut.
func TestEnsureFirewallFromStore_MissingStoreIsSilentAndCorruptIsNot(t *testing.T) {
	var quiet strings.Builder
	srv := newServerForStore(t, filepath.Join(t.TempDir(), "not-written-yet.json"), &quiet)
	srv.ensureFirewallFromStore(context.Background())
	if strings.Contains(quiet.String(), "cannot parse") {
		t.Errorf("a fresh node with no store complained; log said:\n%s", quiet.String())
	}
	if strings.Contains(quiet.String(), "re-ensured") {
		t.Errorf("a fresh node re-ensured something; log said:\n%s", quiet.String())
	}

	path := filepath.Join(t.TempDir(), "inbounds.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	var loud strings.Builder
	srv = newServerForStore(t, path, &loud)
	srv.ensureFirewallFromStore(context.Background())
	if !strings.Contains(loud.String(), "cannot parse persisted inbounds") {
		t.Errorf("a corrupt store was skipped without a word, so the ports stay shut "+
			"and nothing says why; log said:\n%s", loud.String())
	}
}

// No store path configured at all is a legitimate deployment (the agent can be
// run without persistence), and must not read or log anything.
func TestEnsureFirewallFromStore_NoPathConfiguredIsANoop(t *testing.T) {
	var log strings.Builder
	srv := newServerForStore(t, "", &log)
	srv.ensureFirewallFromStore(context.Background())
	if log.Len() != 0 {
		t.Errorf("an agent with no store path still did something; log said:\n%s", log.String())
	}
}
