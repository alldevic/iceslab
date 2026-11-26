package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// bootstrap-wireguard.sh end to end on a fake root (milestone 9.3): paths moved
// under the test's directory, root stubbed, wg, wg-quick, modprobe, ip and
// sysctl stand-ins. The env block that registers the adapter is what the
// script is for; --remove takes only what the agent wrote and refuses an
// interface that is up.
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash.

type wgRun struct{ dir, env, script string }

func newWgRun(t *testing.T, tools bool, ifaceUp bool) wgRun {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if tools {
		write("wg", `echo "wireguard-tools v1.0.20210914 - https://git.zx2c4.com/wireguard-tools/"`+"\n")
		write("wg-quick", "exit 0\n")
	}
	write("modprobe", `echo "modprobe $*" >>"$CALLS"`+"\n")
	write("sysctl", "exit 0\n")
	up := ""
	if ifaceUp {
		up = `echo '5: wg0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue'`
	}
	write("ip", up+"\n")
	scripts := filepath.Join(dir, "scripts")
	if err := os.MkdirAll(filepath.Join(scripts, "lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	lib, _ := os.ReadFile(filepath.Join("scripts", "lib", "node-env.sh"))
	if err := os.WriteFile(filepath.Join(scripts, "lib", "node-env.sh"), lib, 0o644); err != nil {
		t.Fatal(err)
	}
	body := readScript(t, "bootstrap-wireguard.sh")
	body = regexp.MustCompile(`(?m)^(\s*)\[\[ \$EUID -eq 0 \]\] \|\| fail .*$`).ReplaceAllString(body, "${1}true")
	body = strings.ReplaceAll(body, "/etc/wireguard", dir+"/etc/wireguard")
	body = strings.ReplaceAll(body, "/etc/sysctl.d", dir+"/etc/sysctl.d")
	// A machine of this one's own: the distro check reads the real os-release.
	path := filepath.Join(scripts, "bootstrap-wireguard.sh")
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	env := filepath.Join(dir, "env")
	if err := os.WriteFile(env, []byte(baseEnv), 0o600); err != nil {
		t.Fatal(err)
	}
	return wgRun{dir: dir, env: env, script: path}
}

func (r wgRun) run(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command(needBash(t), append([]string{r.script}, args...)...)
	cmd.Env = []string{
		"PATH=" + filepath.Join(r.dir, "bin") + ":/usr/bin:/bin", "HOME=" + r.dir,
		"CALLS=" + filepath.Join(r.dir, "calls"), "ICESLAB_NODE_ENV=" + r.env,
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestBootstrapWireguardWritesTheBlockThatRegistersTheAdapter(t *testing.T) {
	if b, err := os.ReadFile("/etc/os-release"); err != nil || !regexp.MustCompile(`(?m)^ID=("?)(ubuntu|debian)`).Match(b) {
		t.Skip("the script refuses a distro that is not Debian or Ubuntu")
	}
	r := newWgRun(t, true, false)
	out, err := r.run(t)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	env, _ := os.ReadFile(r.env)
	block := "# >>> iceslab-node env:wireguard >>>\nWIREGUARD_BIN=" + r.dir + "/bin/wg\nWIREGUARD_QUICK_BIN=" + r.dir + "/bin/wg-quick\n# <<< iceslab-node env:wireguard <<<"
	if !strings.Contains(string(env), block) {
		t.Errorf("no wireguard block in the env:\n%s", env)
	}
	if fi, err := os.Stat(r.dir + "/etc/wireguard"); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("/etc/wireguard: %v %v", fi, err)
	}
	if b, _ := os.ReadFile(r.dir + "/etc/sysctl.d/99-wg.conf"); !strings.Contains(string(b), "net.ipv4.ip_forward=1") {
		t.Errorf("IP forwarding was not enabled: %q", b)
	}
	if !strings.Contains(out, "WireGuard is ready.") {
		t.Errorf("no summary:\n%s", out)
	}
}

// --remove: the agent's own config and state go, an operator's wg0.conf (no
// state file beside it) stays, the block goes, and a live interface refuses.
func TestBootstrapWireguardRemoveTakesOnlyWhatTheAgentWrote(t *testing.T) {
	r := newWgRun(t, true, false)
	cfg := r.dir + "/etc/wireguard"
	if err := os.MkdirAll(cfg, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.env, []byte(baseEnv+"# >>> iceslab-node env:wireguard >>>\nWIREGUARD_BIN=/usr/bin/wg\n# <<< iceslab-node env:wireguard <<<\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"wg0.conf", "wg0.state.json", "wg1.conf"} {
		if err := os.WriteFile(filepath.Join(cfg, f), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if out, err := r.run(t, "--remove"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	for f, want := range map[string]bool{"wg0.conf": false, "wg0.state.json": false, "wg1.conf": true} {
		if _, err := os.Stat(filepath.Join(cfg, f)); (err == nil) != want {
			t.Errorf("%s present=%v, want %v", f, err == nil, want)
		}
	}
	if env, _ := os.ReadFile(r.env); strings.Contains(string(env), "env:wireguard") || !strings.Contains(string(env), "NODE_PAYLOAD=") {
		t.Errorf("--remove left the block or took the payload:\n%s", env)
	}

	// An operator's own wg0.conf, with no agent state beside it, is not ours.
	r = newWgRun(t, true, false)
	cfg = r.dir + "/etc/wireguard"
	_ = os.MkdirAll(cfg, 0o700)
	_ = os.WriteFile(cfg+"/wg0.conf", []byte("own"), 0o600)
	if out, err := r.run(t, "--remove"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if _, err := os.Stat(cfg + "/wg0.conf"); err != nil {
		t.Error("--remove deleted a wg0.conf the agent never wrote")
	}

	// A WireGuard interface up: refused, nothing touched.
	r = newWgRun(t, true, true)
	cfg = r.dir + "/etc/wireguard"
	_ = os.MkdirAll(cfg, 0o700)
	_ = os.WriteFile(cfg+"/wg0.conf", []byte("x"), 0o600)
	_ = os.WriteFile(cfg+"/wg0.state.json", []byte("x"), 0o600)
	out, err := r.run(t, "--remove")
	if err == nil || !strings.Contains(out, "Stop it first") {
		t.Fatalf("an interface that is up was not refused: %v\n%s", err, out)
	}
	if _, err := os.Stat(cfg + "/wg0.state.json"); err != nil {
		t.Error("a refused --remove still deleted the state")
	}
}
