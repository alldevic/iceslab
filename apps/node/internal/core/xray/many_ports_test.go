package xray

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A-259: one profile of the panel on two ports of a node is two bindings, and
// the push sends them as two inbounds with the SAME config (one REALITY pair,
// one short id) under two ids. The node holds both, tags them apart, puts a
// user of the profile on both, and the core takes the config.
func TestOneProfileOnTwoPorts(t *testing.T) {
	a := multiAdapter(t)
	first := "aaaaaaaa-1111-4000-8000-000000000259"
	second := "bbbbbbbb-2222-4000-8000-000000000259"
	if err := a.ApplyInbound(443, inboundWire(t, first, 443)); err != nil {
		t.Fatalf("first: %v", err)
	}
	if err := a.ApplyInbound(2048, inboundWire(t, second, 2048)); err != nil {
		t.Fatalf("second: %v", err)
	}
	if err := a.AddUserOn(core.User{UserID: "u-alice", XrayUUID: "11111111-1111-4111-8111-111111111111", Username: "alice"},
		[]string{first, second}); err != nil {
		t.Fatalf("AddUserOn: %v", err)
	}

	ports := map[string]float64{}
	users := map[string]int{}
	for _, in := range renderedInbounds(t, a) {
		tag, _ := in["tag"].(string)
		if tag == "api-in" {
			continue
		}
		ports[tag], _ = in["port"].(float64)
		settings, _ := in["settings"].(map[string]any)
		clients, _ := settings["clients"].([]any)
		users[tag] = len(clients)
	}
	tagA, tagB := inboundTagFor(first, "vless-in"), inboundTagFor(second, "vless-in")
	if ports[tagA] != 443 || ports[tagB] != 2048 || len(ports) != 2 {
		t.Fatalf("rendered %v, want %s on 443 and %s on 2048", ports, tagA, tagB)
	}
	if users[tagA] != 1 || users[tagB] != 1 {
		t.Fatalf("the user is not on both inbounds: %v", users)
	}

	bin := os.Getenv("XRAY_BIN")
	if bin == "" {
		t.Skip("XRAY_BIN not set: the config is not asked of the real core here")
	}
	blob, err := renderMultiConfig(currentInbounds(a), sortedClients(a.users), a.cascade, 8080, a.policy, a.dns)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, blob, 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(bin, "run", "-test", "-c", path).CombinedOutput()
	if err != nil {
		t.Fatalf("xray refused one profile on two ports: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "Configuration OK") {
		t.Fatalf("xray did not say OK:\n%s", out)
	}
}
