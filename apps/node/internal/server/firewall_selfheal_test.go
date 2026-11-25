package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
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
// Nothing went in through this door before: its callees were reached through
// applyInbounds only.
//
// The ufw calls go through the fw* seams (recordFirewall), so what each case
// asserts is the rule that would have been opened, and a host that has ufw
// is never touched. The chain half of the function is covered by
// TestTheChainsLinkPortsAreOpenedOnThePushAndAtStart.

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

// writePush stores the whole push, the shape the agent writes now.
func writePush(t *testing.T, inbounds []dto.InboundDto) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "inbounds.json")
	if err := writePushStore(path, dto.ApplyInboundsRequest{Inbounds: inbounds}); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

func TestEnsureFirewallFromStore_OpensEveryPersistedInbound(t *testing.T) {
	fw := recordFirewall(t)
	var log strings.Builder
	srv := newServerForStore(t, writePush(t, []dto.InboundDto{
		{ID: "a", Protocol: dto.ProtocolXray, Port: 443},
		{ID: "b", Protocol: "hysteria", Port: 8443},
		{ID: "c", Protocol: "naive", Port: 9000},
	}), &log)

	srv.ensureFirewallFromStore(context.Background())

	opened, closed := fw.take()
	if want := []string{"443/tcp", "8443/udp", "9000/tcp"}; !reflect.DeepEqual(opened, want) {
		t.Errorf("opened %v, want %v; log said:\n%s", opened, want, log.String())
	}
	if len(closed) != 0 {
		t.Errorf("a boot-time ensure closed %v", closed)
	}
	if !strings.Contains(log.String(), "count=3") {
		t.Errorf("expected the count of re-ensured inbounds; log said:\n%s", log.String())
	}
}

// The store an agent wrote before the whole push was kept is a bare JSON
// array of inbounds; a node that restarts during the rollout still has it.
func TestEnsureFirewallFromStore_ReadsTheLegacyInboundArray(t *testing.T) {
	fw := recordFirewall(t)
	path := filepath.Join(t.TempDir(), "inbounds.json")
	blob, err := json.Marshal([]dto.InboundDto{
		{ID: "a", Protocol: dto.ProtocolXray, Port: 443},
		{ID: "b", Protocol: "hysteria", Port: 8443},
	})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if err := os.WriteFile(path, blob, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	newServerForStore(t, path, nil).ensureFirewallFromStore(context.Background())

	opened, _ := fw.take()
	if want := []string{"443/tcp", "8443/udp"}; !reflect.DeepEqual(opened, want) {
		t.Errorf("opened %v, want %v", opened, want)
	}
}

// An inbound with port 0 (a legacy push) is handed to ensureInboundFirewall,
// which warns and opens nothing; the inbound after it is still opened.
func TestEnsureFirewallFromStore_PassesEachInboundOn(t *testing.T) {
	fw := recordFirewall(t)
	var log strings.Builder
	srv := newServerForStore(t, writePush(t, []dto.InboundDto{
		{ID: "legacy", Protocol: dto.ProtocolXray, Port: 0},
		{ID: "b", Protocol: "hysteria", Port: 8443},
	}), &log)

	srv.ensureFirewallFromStore(context.Background())

	if !strings.Contains(log.String(), "firewall rule NOT opened automatically") {
		t.Errorf("the port-0 inbound never reached ensureInboundFirewall; log said:\n%s", log.String())
	}
	if opened, _ := fw.take(); !reflect.DeepEqual(opened, []string{"8443/udp"}) {
		t.Errorf("opened %v, want only 8443/udp", opened)
	}
}

// A fresh node has no store yet, and a node whose store is corrupt must still
// boot. Neither may take the agent down, but the corrupt one must say so: it
// is the case where ports silently stay shut.
func TestEnsureFirewallFromStore_MissingStoreIsSilentAndCorruptIsNot(t *testing.T) {
	fw := recordFirewall(t)
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
		t.Errorf("a corrupt store was skipped without a word; log said:\n%s", loud.String())
	}
	if !strings.Contains(loud.String(), "level=WARN") {
		t.Errorf("a corrupt store must be a Warn; log said:\n%s", loud.String())
	}
	if opened, closed := fw.take(); len(opened)+len(closed) != 0 {
		t.Errorf("a missing or corrupt store touched the firewall: %v %v", opened, closed)
	}
}

// No store path configured at all is a legitimate deployment (the agent can be
// run without persistence), and must not read, log or open anything.
func TestEnsureFirewallFromStore_NoPathConfiguredIsANoop(t *testing.T) {
	fw := recordFirewall(t)
	var log strings.Builder
	srv := newServerForStore(t, "", &log)
	srv.ensureFirewallFromStore(context.Background())
	if log.Len() != 0 {
		t.Errorf("an agent with no store path still did something; log said:\n%s", log.String())
	}
	if opened, closed := fw.take(); len(opened)+len(closed) != 0 {
		t.Errorf("an agent with no store path touched the firewall: %v %v", opened, closed)
	}
}
