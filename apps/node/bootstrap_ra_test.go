package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// m18.10 follow-up (stand): with net.ipv6.conf.all.forwarding=1 an interface
// with accept_ra=1 stops learning the RA default route; accept_ra=2 keeps it.
// ra_keep_default_route (lib/node-env.sh) writes accept_ra=2 for the default
// route's interface(s) only where it is exactly 1.
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash.

func raRun(t *testing.T, conf string, ra map[string]string, v4dev, v6dev string) string {
	t.Helper()
	dir := t.TempDir()
	for dev, v := range ra {
		p := filepath.Join(dir, "conf", dev, "accept_ra")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(v+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	route := func(dev string) string {
		if dev == "" {
			return ":\n"
		}
		return "echo 'default via 192.0.2.1 dev " + dev + " proto dhcp metric 100'\n"
	}
	bin := stubs(t, map[string]string{
		"ip": `if [ "$1" = -4 ]; then ` + route(v4dev) + `else ` + route(v6dev) + `fi` + "\n",
	})
	confPath := filepath.Join(dir, "99.conf")
	if err := os.WriteFile(confPath, []byte(conf), 0o644); err != nil {
		t.Fatal(err)
	}
	lib, _ := filepath.Abs(filepath.Join("scripts", "lib", "node-env.sh"))
	prog := `log() { :; }; export ICESLAB_IPV6_CONF_DIR=` + dir + `/conf; . ` + lib +
		`; ra_keep_default_route ` + confPath + `; ra_keep_default_route ` + confPath
	if out, err := runBash(t, bin, prog); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	b, _ := os.ReadFile(confPath)
	return string(b)
}

func TestRaKeepDefaultRoute(t *testing.T) {
	const base = "net.ipv6.conf.all.forwarding=1\n"
	// accept_ra=1 on the default route's interface: written once, though run twice.
	got := raRun(t, base, map[string]string{"eth0": "1", "eth1": "1"}, "eth0", "eth0")
	if got != base+"net.ipv6.conf.eth0.accept_ra=2\n" {
		t.Errorf("accept_ra=1: %q", got)
	}
	// A static host (0), one already at 2, and an interface off the default route stay as they are.
	for name, ra := range map[string]map[string]string{
		"static":  {"eth0": "0"},
		"already": {"eth0": "2"},
		"off":     {"eth0": "1"},
	} {
		dev := "eth0"
		if name == "off" {
			dev = "eth9"
		}
		if got := raRun(t, base, ra, dev, ""); got != base {
			t.Errorf("%s: touched the host: %q", name, got)
		}
	}
	// The v6 default route's own interface counts; a dot in the name is a slash in the key.
	got = raRun(t, base, map[string]string{"eth0.100": "1"}, "", "eth0.100")
	if !strings.Contains(got, "net.ipv6.conf.eth0/100.accept_ra=2\n") {
		t.Errorf("dotted interface: %q", got)
	}
}

func TestBootstrapScriptsKeepTheRaDefaultRoute(t *testing.T) {
	for _, s := range []string{"bootstrap-amneziawg.sh", "bootstrap-wireguard.sh"} {
		if !strings.Contains(readScript(t, s), `ra_keep_default_route "$SYSCTL_CONF"`) {
			t.Errorf("%s does not call ra_keep_default_route after enabling forwarding", s)
		}
	}
}
