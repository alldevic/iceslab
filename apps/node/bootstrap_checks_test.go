package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// Stand nl-01, 25.09 (third pass): two bootstrap checks that answered wrong.
//
//   - E33: the naive bootstrap's forward_proxy check failed on one run and
//     passed on the next, the module in the binary all along: `list-modules |
//     grep -q` under pipefail, where grep leaving early kills caddy with
//     SIGPIPE and the pipeline reads as "no module".
//   - The "already the wanted version" path left mtg owned by 501:staff: only
//     a fresh install ran `install -o root`.
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash.

// shellFunc is the definition of `name` in a bootstrap script.
func shellFunc(t *testing.T, script, name string) string {
	t.Helper()
	s := readScript(t, script)
	start := strings.Index(s, "\n"+name+"() {")
	if start == -1 {
		t.Fatalf("%s: no %s()", script, name)
	}
	end := strings.Index(s[start:], "\n}\n")
	return s[start : start+end+3]
}

// stubs puts executables named after the keys of `bodies` on a PATH of their own.
func stubs(t *testing.T, bodies map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range bodies {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func runBash(t *testing.T, path, prog string) (string, error) {
	t.Helper()
	cmd := exec.Command(needBash(t), "-c", prog)
	cmd.Env = []string{"PATH=" + path + ":/usr/bin:/bin"}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestTheNaiveCheckReadsTheWholeModuleList(t *testing.T) {
	verify := shellFunc(t, "bootstrap-naive.sh", "verify_caddy")
	prog := func(caddy string) string {
		return "set -euo pipefail\nlog() { echo \"log: $*\"; }\nfail() { echo \"fail: $*\"; exit 1; }\n" + verify +
			"\nverify_caddy " + caddy + "\necho VERIFIED\n"
	}
	// forward_proxy FIRST, then far more than a pipe holds: the shape that lost
	// the race, grep done at line one while caddy still writes. Plus the JSON
	// log line caddy prints and a CR on the line that matters.
	big := "i=0; while [ $i -lt 20000 ]; do echo \"http.handlers.module_$i\"; i=$((i+1)); done"
	bin := stubs(t, map[string]string{
		"caddy-ok": `if [ "$1" = version ]; then echo '{"level":"info","ts":1790322240.3261952}'; echo 'v2.11.4 h1:x'; exit 0; fi
printf 'http.handlers.forward_proxy \r\n'; ` + big + "\n",
		"caddy-without": `if [ "$1" = version ]; then echo v2.11.4; exit 0; fi
echo http.handlers.file_server; ` + big + "\n",
		"caddy-broken": "echo 'exec format error' >&2; exit 126\n",
	})
	for i := 0; i < 5; i++ {
		out, err := runBash(t, bin, prog(filepath.Join(bin, "caddy-ok")))
		if err != nil || !strings.Contains(out, "VERIFIED") || !strings.Contains(out, "log: "+filepath.Join(bin, "caddy-ok")+" v2.11.4") {
			t.Fatalf("run %d: a caddy with the module was refused: %v\n%s", i, err, out)
		}
	}
	if out, err := runBash(t, bin, prog(filepath.Join(bin, "caddy-without"))); err == nil || !strings.Contains(out, "forward_proxy module not present") {
		t.Errorf("a caddy without the module passed: %v\n%s", err, out)
	}
	if out, err := runBash(t, bin, prog(filepath.Join(bin, "caddy-broken"))); err == nil || !strings.Contains(out, "does not run: exec format error") {
		t.Errorf("a caddy that does not run passed, or said nothing of why: %v\n%s", err, out)
	}
	// And the binary in place is replaced only after the check, by a rename.
	naive := readScript(t, "bootstrap-naive.sh")
	if strings.Index(naive, `verify_caddy "$BUILT"`) > strings.Index(naive, `mv -f "$CADDY_NAIVE_BIN.new" "$CADDY_NAIVE_BIN"`) ||
		strings.Contains(naive, `--output "$CADDY_NAIVE_BIN"`) {
		t.Error("bootstrap-naive.sh builds into, or replaces, the live binary before checking it")
	}
}

// No shell script of the project pipes into `grep -q` any more: the race of
// E33 in any of them. Every script here runs under `set -o pipefail`, so the
// rule is the tree, not a list: the bootstraps of this agent and, since A-104
// (22.10, four live cases in the installers and the backup), the repository's
// own scripts/ too. A new script is covered the day it is added.
func TestNoBootstrapPipesIntoGrepQ(t *testing.T) {
	pipe := regexp.MustCompile(`\|\s*grep\s+(-[A-Za-z]*q|-q)`)
	var files []string
	for _, root := range []string{"scripts", filepath.Join("..", "..", "scripts")} {
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !d.IsDir() && strings.HasSuffix(path, ".sh") {
				files = append(files, path)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", root, err)
		}
	}
	// A walk that found nothing would pass for the wrong reason.
	for _, name := range bootstraps {
		if !slices.Contains(files, filepath.Join("scripts", name)) {
			t.Fatalf("the walk missed %s", name)
		}
	}
	for _, want := range []string{"install-iceslab.sh", "install-iceslab-node.sh", filepath.Join("ops", "iceslab-backup.sh")} {
		if !slices.Contains(files, filepath.Join("..", "..", "scripts", want)) {
			t.Fatalf("the walk missed scripts/%s", want)
		}
	}
	for _, path := range files {
		blob, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(blob), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "#") {
				continue
			}
			if pipe.MatchString(line) {
				t.Errorf("%s:%d pipes into grep -q under pipefail: %s", filepath.ToSlash(path), i+1, strings.TrimSpace(line))
			}
		}
	}
}

// The agent keeps <iface>.state.json beside each AmneziaWG config
// (core/amneziawg/state.go statePath: the server key and the peers). --remove
// that took the configs and left the state brought the old key and peers back
// on the next install instead of what the panel sends.
func TestTheAwgRemoveTakesTheStateWithTheConfigs(t *testing.T) {
	remove := fnBody(t, readScript(t, "bootstrap-amneziawg.sh"), "remove_core")
	for _, want := range []string{"/etc/amnezia/amneziawg/*.conf", "/etc/amnezia/amneziawg/*.state.json"} {
		if !strings.Contains(remove, want) {
			t.Errorf("bootstrap-amneziawg.sh --remove leaves %s behind", want)
		}
	}
}

// The mieru installer leaves mita IDLE: it enables the daemon the agent talks
// to and nothing more. Per mieru's own docs, mita listens only after
// `mita start`, on what `mita apply config` stored. A port open before the
// panel's first push is the agent's to decide (A-153 took the install-time
// 2012 out of the agent's Start), so the installer must never apply, start or
// reload a config of its own. Comments may name the commands; code may not.
func TestTheMieruInstallerLeavesMitaIdle(t *testing.T) {
	script := readScript(t, "bootstrap-mieru.sh")
	// `mita <cmd>` or `"$(mita_bin)" <cmd>`, the two ways the script calls it.
	forbidden := regexp.MustCompile(`(^|[\s;&|(])("?\$\(mita_bin\)"?|mita)\s+(apply|start|reload|restart)\b`)
	for i, line := range strings.Split(script, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		if forbidden.MatchString(line) {
			t.Errorf("bootstrap-mieru.sh:%d runs the proxy itself: %s", i+1, strings.TrimSpace(line))
		}
	}
	// And the daemon it does enable is the unit, not a config with a port in it.
	if !strings.Contains(script, "systemctl enable --now mita.service") {
		t.Error("bootstrap-mieru.sh no longer enables mita.service: the agent's mita calls need the daemon")
	}
	if strings.Contains(script, "2012") {
		t.Error("bootstrap-mieru.sh names port 2012: the port is the panel's push, not the installer's")
	}
}

// A-124: the agent keeps its mTLS pair in /etc/iceslab-node/tls and prefers it
// to NODE_PAYLOAD at start when it chains to the node's CA. Every road to a new
// identity must take that directory away first:
//   - the wipe (--reset, the prompt's yes, --uninstall) removes all of
//     /etc/iceslab-node;
//   - writing a new payload removes tls/ before the env file is written, which
//     covers an install that finds no env and no binary but an old tls/.
func TestEveryNewIdentityTakesTheAgentsDiskPairAway(t *testing.T) {
	wipe := installerFunc(t, "do_uninstall")
	if !strings.Contains(wipe, "rm -rf /etc/iceslab-node\n") {
		t.Error("do_uninstall no longer removes /etc/iceslab-node whole: tls/ would survive --reset")
	}
	blob, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	write := strings.Index(s, "cat > \"$ENV_FILE\" <<EOF\nNODE_PAYLOAD=")
	if write == -1 {
		t.Fatal("no NODE_PAYLOAD write found in the installer")
	}
	// Inside the same branch, before the write: from the branch's `if` to it.
	branch := strings.LastIndex(s[:write], "if [[ -n \"$PAYLOAD\" || ! -f \"$ENV_FILE\" ]]; then")
	if branch == -1 || !strings.Contains(s[branch:write], "rm -rf \"$ENV_DIR/tls\"") {
		t.Error("a new payload is written while an old tls/ may stay: the agent's disk pair would win over it")
	}
}

// A-202: every agent build writes its version in with -X main.version, and the
// variable is there to take it (-X on a name that does not exist is silently
// nothing). Without it the agent said "dev" on every node: the installer's
// build, which is also how a node is updated over SSH, and the image's.
func TestEveryAgentBuildWritesItsVersion(t *testing.T) {
	main, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?m)^var version = `).Match(main) {
		t.Fatal("main.go has no `var version`: -X main.version would set nothing")
	}
	builds := map[string]string{
		"scripts/install-iceslab-node.sh": installerPath,
		"apps/node/Dockerfile":            "Dockerfile",
		".github/workflows/release.yml":   filepath.Join("..", "..", ".github", "workflows", "release.yml"),
	}
	for name, path := range builds {
		blob, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, line := range strings.Split(string(blob), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "#") || !strings.Contains(line, "-ldflags=") {
				continue
			}
			n++
			if !strings.Contains(line, "-X main.version=") {
				t.Errorf("%s builds the agent without its version: %s", name, strings.TrimSpace(line))
			}
		}
		if n == 0 {
			t.Errorf("%s: no -ldflags line found, the build moved and this check no longer sees it", name)
		}
	}
	// The written recipes too: an operator who updates by hand copies these.
	// A command that builds the agent binary must carry the version, and the
	// bare "`go build`" shorthand an upgrade note once used must not come back.
	for name, path := range map[string]string{
		"CHANGELOG.md":        filepath.Join("..", "..", "CHANGELOG.md"),
		"apps/node/README.md": "README.md",
	} {
		blob, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(blob), "\n") {
			builds := strings.Contains(line, "go build") && strings.Contains(line, "iceslab-node")
			if (builds && !strings.Contains(line, "-X main.version=")) || strings.Contains(line, "`go build`") {
				t.Errorf("%s:%d tells to build the agent without its version: %s", name, i+1, strings.TrimSpace(line))
			}
		}
	}
}

// xray's --remove warns that sing-box loses its traffic counters, true when
// xray alone goes. Inside the installer's --uninstall sing-box goes right after,
// and the warning was noise on a clean removal (stand, 26.09).
func TestXrayRemoveWarnsAboutSingboxOnlyWhenSingboxStays(t *testing.T) {
	fn := shellFunc(t, "bootstrap-xray.sh", "remove_core")
	env := filepath.Join(t.TempDir(), "env")
	if err := os.WriteFile(env, []byte("SINGBOX_BINARY=/usr/local/bin/sing-box\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := stubs(t, map[string]string{"systemctl": "exit 0\n"})
	prog := func(flag string) string {
		return "set -euo pipefail\n" + flag +
			"log() { echo \"log: $*\"; }\nwarn() { echo \"warn: $*\"; }\n" +
			"node_env_refuse_if_running() { :; }\nnode_env_pids() { :; }\ndisable_upstream_unit() { :; }\nunwire_env() { :; }\n" +
			"INSTALL_PATH='" + filepath.Join(t.TempDir(), "xray") + "'\nICESLAB_NODE_ENV='" + env + "'\n" +
			fn + "\nremove_core\n"
	}
	out, err := runBash(t, bin, prog(""))
	if err != nil || !strings.Contains(out, "warn: sing-box on this node") {
		t.Errorf("xray removed alone: no warning about sing-box: %v\n%s", err, out)
	}
	out, err = runBash(t, bin, prog("export ICESLAB_UNINSTALL=1\n"))
	if err != nil || strings.Contains(out, "warn:") || !strings.Contains(out, "log: xray removed") {
		t.Errorf("inside --uninstall: %v\n%s", err, out)
	}
}

func TestAnAlreadyInstalledBinaryIsMadeRootOwned(t *testing.T) {
	lib, err := filepath.Abs(filepath.Join("scripts", "lib", "node-env.sh"))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ owner, wantChown string }{
		{"501:20", "chown root:root BIN\n"},
		{"0:0", ""},
	} {
		dir := stubs(t, map[string]string{
			"stat":  "echo '" + c.owner + "'\n",
			"chown": `echo "chown $*" >>"$CALLS"` + "\n",
			"chmod": `echo "chmod $*" >>"$CALLS"` + "\n",
		})
		calls := filepath.Join(t.TempDir(), "calls")
		bin := filepath.Join(t.TempDir(), "BIN")
		if err := os.WriteFile(bin, []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(needBash(t), "-c", "set -euo pipefail\n. '"+lib+"'\nnode_env_own_by_root '"+bin+"'\n")
		cmd.Env = []string{"PATH=" + dir + ":/usr/bin:/bin", "CALLS=" + calls}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v\n%s", c.owner, err, out)
		}
		got, _ := os.ReadFile(calls)
		wantChown := strings.ReplaceAll(c.wantChown, "BIN", bin)
		if wantChown != "" && !strings.Contains(string(got), wantChown) {
			t.Errorf("owner %s: no chown to root:\n%s", c.owner, got)
		}
		if wantChown == "" && strings.Contains(string(got), "chown") {
			t.Errorf("owner %s: chowned a root-owned file:\n%s", c.owner, got)
		}
		if !strings.Contains(string(got), "chmod go-w "+bin) {
			t.Errorf("owner %s: not made unwritable by others:\n%s", c.owner, got)
		}
	}
	// Every "already the wanted version" exit of a downloaded binary calls it.
	for _, name := range []string{"bootstrap-mtg.sh", "bootstrap-xray.sh", "bootstrap-hysteria.sh"} {
		if !regexp.MustCompile(`already installed, which is the wanted version"\n\s+node_env_own_by_root "\$INSTALL_PATH"`).MatchString(readScript(t, name)) {
			t.Errorf("%s: the already-installed path does not make the binary root-owned", name)
		}
	}
}
