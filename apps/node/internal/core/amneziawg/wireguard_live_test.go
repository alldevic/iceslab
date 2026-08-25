package amneziawg

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A real interface, on a real kernel, driven by the real adapter.
//
// Everything else in this package stops at the config file: the unit tests run
// in config-only mode because a CI box has no wg-quick and no CAP_NET_ADMIN. So
// the claim that MATTERS - that what we render actually brings an interface up
// and takes a peer - was the one thing never checked. This closes that, and is
// skipped unless ICESLAB_LIVE_WG=1, because it needs root, the wireguard module,
// and it will bounce wg0 on whatever host it runs on.
//
//	go test -c ./internal/core/amneziawg/ -o /tmp/wgtest
//	scp /tmp/wgtest node:/tmp/ && ssh node 'ICESLAB_LIVE_WG=1 /tmp/wgtest -test.run TestLive -test.v'
func TestLiveWireguardInterface(t *testing.T) {
	if os.Getenv("ICESLAB_LIVE_WG") != "1" {
		t.Skip("live test: set ICESLAB_LIVE_WG=1 on a host with root + the wireguard module")
	}

	serverPriv, serverPub := genKeypair(t)
	_, clientPub := genKeypair(t)

	a := New(Config{
		Protocol:     NameWireguard,
		AwgBin:       "/usr/bin/wg",
		AwgQuickBin:  "/usr/bin/wg-quick",
		SystemctlBin: "/usr/bin/systemctl",
		ConfigPath:   "/etc/wireguard/wg0.conf",
		Inbound:      InboundConfig{Interface: "wg0"},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { _ = a.Stop(context.Background()) })

	// Exactly the shape panel-backend pushes for a wireguard profile: no
	// obfuscation member at all.
	raw, err := json.Marshal(map[string]any{
		"subnet":           "10.77.77.0/24",
		"serverPrivateKey": serverPriv,
		"serverPublicKey":  serverPub,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := a.ApplyInbound(1234, raw); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}

	blob, err := os.ReadFile("/etc/wireguard/wg0.conf")
	if err != nil {
		t.Fatalf("read rendered config: %v", err)
	}
	for _, key := range []string{"Jc", "S1", "H1", "I1"} {
		if strings.Contains(string(blob), key+" =") {
			t.Fatalf("rendered config carries the AmneziaWG key %q, wg-quick would refuse it:\n%s", key, blob)
		}
	}

	// The interface is up and listening where the panel said, which is the
	// thing config-only tests cannot see.
	show := run(t, "/usr/bin/wg", "show", "wg0")
	if !strings.Contains(show, "listening port: 1234") {
		t.Errorf("interface not on the pushed port:\n%s", show)
	}
	if addr := run(t, "/usr/sbin/ip", "-4", "addr", "show", "wg0"); !strings.Contains(addr, "10.77.77.1/24") {
		t.Errorf("server tunnel address not derived from the subnet:\n%s", addr)
	}

	if err := a.AddUser(core.User{
		UserID:             "u-live",
		WireguardPublicKey: clientPub,
		WireguardAllowedIP: "10.77.77.2",
	}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	dump := run(t, "/usr/bin/wg", "show", "wg0", "dump")
	if !strings.Contains(dump, clientPub) || !strings.Contains(dump, "10.77.77.2/32") {
		t.Errorf("peer did not reach the kernel:\n%s", dump)
	}

	// An AmneziaWG-only user is not this interface's business.
	if err := a.AddUser(core.User{
		UserID:             "u-awg",
		AmneziaWGPublicKey: clientPub,
		AmneziaWGAllowedIP: "10.66.66.2",
	}); err != nil {
		t.Fatalf("AddUser awg-only: %v", err)
	}
	if strings.Contains(run(t, "/usr/bin/wg", "show", "wg0", "dump"), "10.66.66.2") {
		t.Error("an amneziawg-only user landed on the plain interface")
	}

	// First sight of a peer reports zero rather than its lifetime counter.
	stats, err := a.GetStats()
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	var seen bool
	for _, u := range stats.Users {
		if u.UserID == "u-live" {
			seen = true
			if u.BytesIn != 0 || u.BytesOut != 0 {
				t.Errorf("first poll should be a zero delta, got %d/%d", u.BytesIn, u.BytesOut)
			}
		}
	}
	if !seen {
		t.Error("GetStats did not report the live peer")
	}

	if !a.Healthy() {
		t.Error("adapter reports unhealthy with the interface up")
	}

	if err := a.RemoveUser("u-live"); err != nil {
		t.Fatalf("RemoveUser: %v", err)
	}
	if strings.Contains(run(t, "/usr/bin/wg", "show", "wg0", "dump"), clientPub) {
		t.Error("peer survived RemoveUser")
	}
}

func genKeypair(t *testing.T) (priv, pub string) {
	t.Helper()
	priv = strings.TrimSpace(run(t, "/usr/bin/wg", "genkey"))
	cmd := exec.Command("/usr/bin/wg", "pubkey")
	cmd.Stdin = strings.NewReader(priv + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("wg pubkey: %v", err)
	}
	return priv, strings.TrimSpace(string(out))
}

func run(t *testing.T, name string, args ...string) string {
	t.Helper()
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v (%s)", name, args, err, out)
	}
	return fmt.Sprintf("%s", out)
}
