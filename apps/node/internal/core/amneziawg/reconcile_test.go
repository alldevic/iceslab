package amneziawg

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// What the panel pushes is the node's WHOLE set - of inbounds and of users -
// but it is dispatched one at a time, so an adapter that only ever adds cannot
// notice a removal. For a wg flavour that is not bookkeeping: the interface is
// the listener and a peer is the access.
//
// Measured 2026-08-31 on the live node: both wg bindings disabled in the panel,
// `awg0` and `wg0` still up with every peer and port. The only way back was
// `awg-quick down` on the box, and nothing in the panel said so.

// managedAdapter builds an adapter that "runs" the CLI, recording every
// invocation, so a teardown can be observed rather than inferred.
func managedAdapter(t *testing.T, protocol string) (*Adapter, *[]string, string) {
	t.Helper()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "iface.conf")
	var mu sync.Mutex
	calls := []string{}
	a := New(Config{
		Protocol:     protocol,
		Inbound:      validInbound(),
		ConfigPath:   cfgPath,
		AwgBin:       "/usr/bin/awg",
		AwgQuickBin:  "/usr/bin/awg-quick",
		SystemctlBin: "/usr/bin/systemctl",
		runCmd: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			mu.Lock()
			defer mu.Unlock()
			calls = append(calls, name+" "+strings.Join(args, " "))
			return []byte(""), nil
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.cfg.Inbound.Interface = "awg0"
	return a, &calls, cfgPath
}

// applyPushed feeds the adapter a panel-shaped inbound config, which is the only
// way it learns its own id.
func applyPushed(t *testing.T, a *Adapter, inboundID string, port int) {
	t.Helper()
	wire := map[string]any{
		"inboundId":        inboundID,
		"subnet":           "10.66.66.0/24",
		"serverPrivateKey": testWGPrivKey,
		"obfuscation": map[string]any{
			"jc": 4, "jmin": 40, "jmax": 70,
			"s1": 72, "s2": 56, "s3": 0, "s4": 0,
			"h1": 100, "h2": 200, "h3": 300, "h4": 400,
		},
	}
	raw, err := json.Marshal(wire)
	if err != nil {
		t.Fatalf("marshal wire: %v", err)
	}
	if err := a.ApplyInbound(port, raw); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
}

func addPeer(t *testing.T, a *Adapter, id, pub, ip string) {
	t.Helper()
	if err := a.AddUser(core.User{UserID: id, AmneziaWGPublicKey: pub, AmneziaWGAllowedIP: ip}); err != nil {
		t.Fatalf("AddUser %s: %v", id, err)
	}
}

func TestRetainInboundsTakesTheInterfaceDownWhenTheInboundIsGone(t *testing.T) {
	a, calls, _ := managedAdapter(t, Name)
	applyPushed(t, a, "binding-1", 1234)
	addPeer(t, a, "dev-1", testWGPubKeyA, "10.66.66.2")

	// The push that no longer carries it. An empty keep set is the ordinary way
	// this happens: the operator disabled the last wg binding.
	if err := a.RetainInbounds(nil); err != nil {
		t.Fatalf("RetainInbounds: %v", err)
	}

	if !strings.Contains(strings.Join(*calls, "\n"), "awg-quick down awg0") {
		t.Errorf("the interface was left up; calls=%v", *calls)
	}
	if a.Healthy() {
		t.Errorf("Healthy still true after the inbound was removed")
	}
	if a.Provisioned() {
		t.Errorf("Provisioned still true: /healthz would report a configured core that died, " +
			"rather than one nobody has configured")
	}
	if len(a.peers) != 0 {
		t.Errorf("peers survived the inbound: %v", a.peers)
	}
}

func TestRetainInboundsKeepsAnInboundThePushStillCarries(t *testing.T) {
	// The control. A teardown that ran on every push would pass the case above
	// just as well, and would take the node's tunnels down on an unrelated edit.
	a, calls, _ := managedAdapter(t, Name)
	applyPushed(t, a, "binding-1", 1234)
	addPeer(t, a, "dev-1", testWGPubKeyA, "10.66.66.2")
	before := len(*calls)

	if err := a.RetainInbounds([]string{"binding-1", "other-binding"}); err != nil {
		t.Fatalf("RetainInbounds: %v", err)
	}
	if strings.Contains(strings.Join((*calls)[before:], "\n"), "down") {
		t.Errorf("a live inbound was torn down; calls=%v", (*calls)[before:])
	}
	if !a.Provisioned() {
		t.Errorf("a live inbound lost its configuration")
	}
	if len(a.peers) != 1 {
		t.Errorf("peers of a live inbound were dropped: %v", a.peers)
	}
}

func TestRetainInboundsDoesNothingWithoutAnIdentifiedInbound(t *testing.T) {
	// An install-time interface, or a panel too old to send the id. There is
	// nothing to compare against, and taking that interface down on a push about
	// other protocols would remove a working tunnel for no reason.
	a, calls, _ := managedAdapter(t, Name)
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	before := len(*calls)
	if err := a.RetainInbounds(nil); err != nil {
		t.Fatalf("RetainInbounds: %v", err)
	}
	if strings.Contains(strings.Join((*calls)[before:], "\n"), "down") {
		t.Errorf("an unidentified interface was torn down; calls=%v", (*calls)[before:])
	}
	if !a.Provisioned() {
		t.Errorf("an unidentified interface lost its configuration")
	}
}

func TestRetainUsersDropsPeersThePanelNoLongerLists(t *testing.T) {
	a, _, cfgPath := managedAdapter(t, Name)
	applyPushed(t, a, "binding-1", 1234)
	addPeer(t, a, "dev-1", testWGPubKeyA, "10.66.66.2")
	addPeer(t, a, "dev-2", testWGPubKeyB, "10.66.66.3")

	// dev-2 is gone from the panel and nobody ever said so by name.
	if err := a.RetainUsers([]string{"dev-1", "some-user-id"}); err != nil {
		t.Fatalf("RetainUsers: %v", err)
	}
	if _, still := a.peers["dev-2"]; still {
		t.Errorf("a peer the panel no longer lists is still held")
	}
	if _, gone := a.peers["dev-1"]; !gone {
		t.Errorf("a peer the panel still lists was dropped")
	}

	// The kernel is what serves traffic, so the written config is the claim that
	// matters, not the map.
	blob, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if strings.Contains(string(blob), testWGPubKeyB) {
		t.Errorf("the removed peer is still in the config the interface is synced from:\n%s", blob)
	}
	if !strings.Contains(string(blob), testWGPubKeyA) {
		t.Errorf("the retained peer went missing from the config:\n%s", blob)
	}
}

func TestRetainUsersHonoursAnEmptySet(t *testing.T) {
	// "This node serves nobody" is a legitimate state - every user disabled -
	// and ignoring it would be the same silence this interface exists to end.
	a, _, cfgPath := managedAdapter(t, Name)
	applyPushed(t, a, "binding-1", 1234)
	addPeer(t, a, "dev-1", testWGPubKeyA, "10.66.66.2")

	if err := a.RetainUsers(nil); err != nil {
		t.Fatalf("RetainUsers: %v", err)
	}
	if len(a.peers) != 0 {
		t.Errorf("peers survived an empty keep set: %v", a.peers)
	}
	blob, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if strings.Contains(string(blob), "[Peer]") {
		t.Errorf("the config still carries a peer:\n%s", blob)
	}
}

func TestRetainUsersIsQuietWhenNothingChanged(t *testing.T) {
	// It runs on every user sync, so a reload per sync would bounce peers for
	// nothing. Nothing dropped means no IO at all.
	a, calls, _ := managedAdapter(t, Name)
	applyPushed(t, a, "binding-1", 1234)
	addPeer(t, a, "dev-1", testWGPubKeyA, "10.66.66.2")
	before := len(*calls)

	if err := a.RetainUsers([]string{"dev-1"}); err != nil {
		t.Fatalf("RetainUsers: %v", err)
	}
	if len(*calls) != before {
		t.Errorf("a no-op reconcile still touched the interface: %v", (*calls)[before:])
	}
}

func TestBothWgFlavoursReconcile(t *testing.T) {
	// One package serves amneziawg and upstream wireguard as two instances, and
	// the defect was the same on both. Asserting the interfaces here means a
	// flavour cannot be left behind.
	for _, protocol := range []string{Name, NameWireguard} {
		t.Run(protocol, func(t *testing.T) {
			a := New(Config{Protocol: protocol, Inbound: validInbound()},
				slog.New(slog.NewTextHandler(io.Discard, nil)))
			var _ core.InboundReconciler = a
			var _ core.UserReconciler = a
			if _, multi := any(a).(core.MultiInbound); multi {
				t.Errorf("%s claims to hold several inbounds; ApplyInbound overwrites one field",
					protocol)
			}
		})
	}
}
