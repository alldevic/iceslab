package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// E41, 25.09 on ru-01: --uninstall left xray, sing-box, hysteria and the AWG
// module on the machine, and the next install found them. --uninstall now stops
// the agent, stops every core, runs each bootstrap's --remove from the checkout
// while it is there, and only then removes the checkout. Run for real: the
// installer's uninstall functions in bash, against a fake checkout whose
// bootstraps note their call, with systemctl, ip, awg-quick, pkill and pgrep
// stubbed.
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash.

// installerFunc is the definition of `name` in the installer.
func installerFunc(t *testing.T, name string) string {
	t.Helper()
	blob, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	start := strings.Index(s, "\n"+name+"() {")
	if start == -1 {
		t.Fatalf("the installer has no %s()", name)
	}
	end := strings.Index(s[start:], "\n}\n")
	return s[start : start+end+3]
}

type uninstallRun struct {
	out, calls string
	checkout   string
	root       string
	err        error
}

// A machine with a node on it, as `ufw status` shows it: the agent's port, the
// protocols' open rules, the operator's SSH, and two rules that name a source.
const ufwBusy = `Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
9443/tcp                   ALLOW       Anywhere
443/tcp                    ALLOW       Anywhere
443/udp                    ALLOW       Anywhere
80/tcp                     ALLOW       Anywhere
1234/udp                   ALLOW       Anywhere
443/tcp                    ALLOW       203.0.113.4
80/tcp                     ALLOW       198.51.100.0/24
22/tcp (v6)                ALLOW       Anywhere (v6)
443/tcp (v6)               ALLOW       Anywhere (v6)
`

// uninstallOpts: what runUninstall sets up. present is the cores core_present
// answers yes for; failCore's --remove exits 1; legacyCore's bootstrap predates
// --remove; ufw is what `ufw status` prints ("" is ufwBusy); forwardPolicy is
// the DEFAULT_FORWARD_POLICY of ufw's defaults file; reset runs do_uninstall
// alone, the way --reset does, instead of uninstall_all.
type uninstallOpts struct {
	keepCores                 bool
	present, failCore, legacy string
	ufw, forwardPolicy        string
	reset                     bool
}

func runUninstall(t *testing.T, keepCores bool, present, failCore, legacyCore string) uninstallRun {
	return runUninstallWith(t, uninstallOpts{keepCores: keepCores, present: present, failCore: failCore, legacy: legacyCore})
}

// runUninstallWith runs the installer's uninstall functions against a fake
// machine: every /etc/ and /usr/local/ path of do_uninstall is moved under a
// temp root, so a test never touches the machine's own files (nor reads them),
// and a fail2ban jail.local of the operator's is there to be left alone.
func runUninstallWith(t *testing.T, o uninstallOpts) uninstallRun {
	t.Helper()
	bash := needBash(t)
	keepCores, present, failCore, legacyCore := o.keepCores, o.present, o.failCore, o.legacy
	root := t.TempDir()
	machine := filepath.Join(root, "machine")
	for _, d := range []string{"etc/fail2ban/jail.d", "etc/fail2ban/filter.d", "etc/iceslab-node", "usr/local/bin"} {
		if err := os.MkdirAll(filepath.Join(machine, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for f, body := range map[string]string{
		"etc/fail2ban/jail.local":                     "[sshd]\nenabled = true\nmaxretry = 3\n",
		"etc/fail2ban/jail.d/iceslab.local":           "[sshd]\n",
		"etc/fail2ban/filter.d/iceslab-hysteria.conf": "[Definition]\n",
		"etc/fail2ban/jail.d/defaults-debian.conf":    "[sshd]\nenabled = true\n",
		"etc/iceslab-node/env":                        "NODE_PAYLOAD=x\n",
		"usr/local/bin/iceslab-node":                  "binary",
	} {
		if err := os.WriteFile(filepath.Join(machine, f), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	checkout := filepath.Join(root, "opt", "iceslab-node")
	scripts := filepath.Join(checkout, "apps", "node", "scripts")
	if err := os.MkdirAll(scripts, 0o755); err != nil {
		t.Fatal(err)
	}
	calls := filepath.Join(root, "calls")
	for engine, name := range bootstraps {
		body := "#!/usr/bin/env bash\n# handles NODE_ENV_REMOVE\n"
		if engine == legacyCore {
			body = "#!/usr/bin/env bash\n# an old bootstrap: any flag is an install\n"
		}
		body += "if [ -d '" + checkout + "' ]; then c=yes; else c=no; fi\n" +
			"echo \"bootstrap " + engine + " $* checkout=$c\" >>'" + calls + "'\n" +
			"echo \"uninstall-flag " + engine + " ${ICESLAB_UNINSTALL:-unset}\" >>'" + calls + "'\n"
		if engine == failCore {
			body += "echo '" + engine + " is running: not removed' >&2; exit 1\n"
		}
		if err := os.WriteFile(filepath.Join(scripts, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	note := `echo "$(basename "$0") $*" >>'` + calls + "'\n"
	status := o.ufw
	if status == "" {
		status = ufwBusy
	}
	statusFile := filepath.Join(root, "ufw-status")
	if err := os.WriteFile(statusFile, []byte(status), 0o644); err != nil {
		t.Fatal(err)
	}
	defaults := filepath.Join(root, "ufw-default")
	policy := o.forwardPolicy
	if policy == "" {
		policy = "DROP"
	}
	if err := os.WriteFile(defaults, []byte("DEFAULT_FORWARD_POLICY=\""+policy+"\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := stubs(t, map[string]string{
		"ufw":       note + `if [ "$1" = status ]; then cat '` + statusFile + "'; fi\n",
		"systemctl": note,
		"awg-quick": note,
		"pkill":     note,
		"pgrep":     "exit 1\n",
		"ip":        note + `if [ "$1" = -o ]; then echo '7: awg0: <POINTOPOINT,NOARP,UP> mtu 1420'; echo '9: awg-l1: <POINTOPOINT,NOARP,UP> mtu 1420'; fi` + "\n",
	})
	keep := "0"
	if keepCores {
		keep = "1"
	}
	prog := "set -euo pipefail\n" +
		"log() { echo \"log: $*\"; echo \"log: $*\" >>'" + calls + "'; }\nwarn() { echo \"warn: $*\"; }\nfail() { echo \"fail: $*\"; exit 1; }\n" +
		"KNOWN_ENGINES=\"xray singbox hysteria amneziawg mtproto mtprotoproxy mieru naive\"\n" +
		"CORE_PROCESSES=\"xray sing-box hysteria mtg caddy-naive mita\"\n" +
		"MTPROTOPROXY_SCRIPT_PATH=/nonexistent/mtprotoproxy.py\n" +
		installerFunc(t, "bootstrap_of") + installerFunc(t, "stop_cores") + installerFunc(t, "remove_cores") +
		isolated(installerFunc(t, "do_uninstall"), machine) + installerFunc(t, "uninstall_all") +
		// After the installer's own: what is on this fake machine.
		"core_present() { [[ \" " + present + " \" == *\" $1 \"* ]]; }\n" +
		"PROTOCOL_PORTS=\"" + installerVar(t, "PROTOCOL_PORTS") + "\"\nUFW_DEFAULT_FILE='" + defaults + "'\n" +
		"ICESLAB_NODE_DIR='" + checkout + "'\nNODE_PORT=9443\nKEEP_CORES=" + keep + "\n"
	if o.reset {
		prog += "do_uninstall\n"
	} else {
		prog += "uninstall_all\n"
	}
	cmd := exec.Command(bash, "-c", prog)
	cmd.Env = []string{"PATH=" + bin + ":/usr/bin:/bin"}
	out, err := cmd.CombinedOutput()
	c, _ := os.ReadFile(calls)
	return uninstallRun{out: string(out), calls: string(c), checkout: checkout, root: machine, err: err}
}

// isolated is fn with the paths it removes moved under root.
func isolated(fn, root string) string {
	return strings.NewReplacer("/etc/", root+"/etc/", "/usr/local/", root+"/usr/local/").Replace(fn)
}

// installerVar is the value of a top-level NAME="value" of the installer.
func installerVar(t *testing.T, name string) string {
	t.Helper()
	m := regexp.MustCompile(`(?m)^` + name + `="([^"]*)"$`).FindStringSubmatch(readInstaller(t))
	if m == nil {
		t.Fatalf("the installer has no %s", name)
	}
	return m[1]
}

// at is the line of the first call starting with prefix, -1 when none.
func at(calls, prefix string) int {
	for i, line := range strings.Split(calls, "\n") {
		if strings.HasPrefix(line, prefix) {
			return i
		}
	}
	return -1
}

func TestUninstallStopsThenRemovesThenDeletesTheCheckout(t *testing.T) {
	r := runUninstall(t, false, "xray hysteria amneziawg", "", "")
	if r.err != nil {
		t.Fatalf("%v\n%s", r.err, r.out)
	}
	order := []string{
		"systemctl stop iceslab-node",
		"systemctl stop hysteria",
		"awg-quick down awg0",
		"pkill -TERM -x xray",
		"bootstrap xray --remove",
		"log: Removing source checkout",
	}
	last := -1
	for _, step := range order {
		i := at(r.calls, step)
		if i == -1 || i < last {
			t.Fatalf("%q missing or out of order (line %d after %d):\n%s", step, i, last, r.calls)
		}
		last = i
	}
	// The cascade leg's tunnel comes down too, and a --remove never runs
	// without the checkout it lives in.
	if at(r.calls, "awg-quick down awg-l1") == -1 {
		t.Errorf("the cascade leg's interface was left up:\n%s", r.calls)
	}
	for _, line := range strings.Split(r.calls, "\n") {
		if strings.HasPrefix(line, "bootstrap ") && !strings.HasSuffix(line, "--remove checkout=yes") {
			t.Errorf("a bootstrap ran without --remove or without its checkout: %q", line)
		}
	}
	// Every bootstrap is asked, present or not: a --remove of nothing sweeps
	// what an older install left.
	for engine := range bootstraps {
		if at(r.calls, "bootstrap "+engine+" --remove") == -1 {
			t.Errorf("%s's --remove did not run", engine)
		}
	}
	// Each --remove knows it is part of a whole uninstall, so it keeps quiet
	// about the cores that are about to go anyway.
	for engine := range bootstraps {
		if at(r.calls, "uninstall-flag "+engine+" 1") == -1 {
			t.Errorf("%s's --remove ran without ICESLAB_UNINSTALL=1:\n%s", engine, r.calls)
		}
	}
	if _, err := os.Stat(r.checkout); !os.IsNotExist(err) {
		t.Errorf("the checkout is still there: %v", err)
	}
	if !strings.Contains(r.out, "Removed: agent, xray, hysteria, amneziawg; kept: none") {
		t.Errorf("summary:\n%s", r.out)
	}
}

func TestUninstallSaysWhichCoreStayedAndWhy(t *testing.T) {
	r := runUninstall(t, false, "xray hysteria singbox", "hysteria", "singbox")
	if r.err != nil {
		t.Fatalf("a refused --remove ended the uninstall: %v\n%s", r.err, r.out)
	}
	// A bootstrap from before --remove would take the flag for an install.
	if at(r.calls, "bootstrap singbox") != -1 {
		t.Errorf("an old bootstrap was run, it would have installed the core again:\n%s", r.calls)
	}
	want := "Removed: agent, xray; kept: singbox (the checkout predates --remove), hysteria (its --remove refused, see above)"
	if !strings.Contains(r.out, want) {
		t.Errorf("summary, want %q:\n%s", want, r.out)
	}
}

func TestKeepCoresTouchesNoCore(t *testing.T) {
	r := runUninstall(t, true, "xray hysteria", "", "")
	if r.err != nil {
		t.Fatalf("%v\n%s", r.err, r.out)
	}
	for _, not := range []string{"bootstrap ", "pkill ", "awg-quick "} {
		if at(r.calls, not) != -1 {
			t.Errorf("--keep-cores ran %q:\n%s", not, r.calls)
		}
	}
	if at(r.calls, "log: Removing source checkout") == -1 {
		t.Errorf("--keep-cores skipped the agent's own uninstall:\n%s", r.calls)
	}
	if !strings.Contains(r.out, "Removed: agent; kept: every core (--keep-cores)") {
		t.Errorf("summary:\n%s", r.out)
	}
}

// 198b3509: --uninstall deleted /etc/fail2ban/jail.local, fail2ban's own place
// for local configuration where an operator's jails live, on the strength of a
// comment that called it a legacy path of this script. No version ever wrote it.
// Ours (jail.d/iceslab.local and the filter) go; theirs stay.
func TestUninstallLeavesTheOperatorsFail2banConfig(t *testing.T) {
	for _, o := range []uninstallOpts{{}, {keepCores: true}, {reset: true}} {
		r := runUninstallWith(t, o)
		if r.err != nil {
			t.Fatalf("%+v: %v\n%s", o, r.err, r.out)
		}
		for _, kept := range []string{"etc/fail2ban/jail.local", "etc/fail2ban/jail.d/defaults-debian.conf"} {
			if _, err := os.Stat(filepath.Join(r.root, kept)); err != nil {
				t.Errorf("%+v: %s is gone: %v", o, kept, err)
			}
		}
		for _, gone := range []string{"etc/fail2ban/jail.d/iceslab.local", "etc/fail2ban/filter.d/iceslab-hysteria.conf", "etc/iceslab-node", "usr/local/bin/iceslab-node"} {
			if _, err := os.Stat(filepath.Join(r.root, gone)); !os.IsNotExist(err) {
				t.Errorf("%+v: %s is still there: %v", o, gone, err)
			}
		}
	}
}

// ufwCalls is what the uninstall asked ufw to delete.
func ufwDeletes(calls string) []string {
	var out []string
	for _, line := range strings.Split(calls, "\n") {
		if strings.HasPrefix(line, "ufw --force delete") {
			out = append(out, strings.TrimPrefix(line, "ufw --force delete allow "))
		}
	}
	return out
}

// The firewall step opens 443/tcp, 443/udp, 80/tcp and 1234/udp for the cores
// and the agent's port; --uninstall used to take off the agent's port only. The
// open rules go, the ones that name a source stay (`ufw delete allow 443/tcp`
// is the open rule alone), SSH is never touched. --keep-cores keeps the
// protocols' rules (the customer's decision for 5.4: the cores stay and the
// operator may run them), --reset takes them off like a full uninstall.
func TestUninstallTakesOffTheProtocolRulesButNotTheOnesWithASource(t *testing.T) {
	all := "9443/tcp 443/tcp 443/udp 80/tcp 1234/udp"
	for _, c := range []struct {
		name string
		o    uninstallOpts
		want string
	}{
		{"full uninstall", uninstallOpts{}, all},
		{"--reset", uninstallOpts{reset: true}, all},
		{"--keep-cores", uninstallOpts{keepCores: true}, "9443/tcp"},
	} {
		r := runUninstallWith(t, c.o)
		if r.err != nil {
			t.Fatalf("%s: %v\n%s", c.name, r.err, r.out)
		}
		if got := strings.Join(ufwDeletes(r.calls), " "); got != c.want {
			t.Errorf("%s: ufw deleted %q, want %q:\n%s", c.name, got, c.want, r.calls)
		}
		if strings.Contains(r.calls, "22/tcp") || strings.Contains(r.calls, "203.0.113.4") || strings.Contains(r.calls, "198.51.100.0") {
			t.Errorf("%s: a rule that is not the protocols' was touched:\n%s", c.name, r.calls)
		}
	}

	// Only rules that name a source: nothing of the protocols' to take off.
	only := "Status: active\n\nTo                         Action      From\n--                         ------      ----\n" +
		"443/tcp                    ALLOW       203.0.113.4\n80/tcp                     ALLOW       198.51.100.0/24\n" +
		"1234/udp                   LIMIT       Anywhere\n"
	r := runUninstallWith(t, uninstallOpts{ufw: only})
	if r.err != nil || len(ufwDeletes(r.calls)) != 0 {
		t.Errorf("rules with a source: %v, deleted %v:\n%s", r.err, ufwDeletes(r.calls), r.calls)
	}

	// A machine without ufw at all.
	r = runUninstallWith(t, uninstallOpts{ufw: "Status: inactive\n"})
	if r.err != nil || len(ufwDeletes(r.calls)) != 0 {
		t.Errorf("ufw inactive: %v, deleted %v", r.err, ufwDeletes(r.calls))
	}
}

// --panel-ip makes the agent's rule one per panel IP ("allow from <ip> to any
// port N proto tcp"), and `ufw delete allow N/tcp` does not take those: on the
// stand 1337/tcp ALLOW <panel> outlived --uninstall. The sources are read off
// `ufw status`; every agent-port rule with a source goes (full, --keep-cores,
// --reset alike), rules on other ports keep theirs.
func TestUninstallTakesOffTheAgentPortRulesOfThePanelIPs(t *testing.T) {
	status := "Status: active\n\nTo                         Action      From\n--                         ------      ----\n" +
		"22/tcp                     ALLOW       Anywhere\n" +
		"9443/tcp                   ALLOW       192.168.122.1\n" +
		"9443/tcp                   ALLOW       10.0.0.0/8\n" +
		"9443/tcp (v6)              ALLOW       2001:db8::1\n" +
		"9443/tcp                   ALLOW IN    198.51.100.7\n" +
		"94430/tcp                  ALLOW       192.0.2.1\n" +
		"9443/udp                   ALLOW       192.0.2.2\n" +
		"9444/tcp                   ALLOW       192.168.122.1\n" +
		"443/tcp                    ALLOW       203.0.113.4\n" +
		"22/tcp                     ALLOW       192.168.122.1\n"
	panel := "9443/tcp from 192.168.122.1 to any port 9443 proto tcp from 10.0.0.0/8 to any port 9443 proto tcp " +
		"from 2001:db8::1 to any port 9443 proto tcp from 198.51.100.7 to any port 9443 proto tcp"
	for _, c := range []struct {
		name string
		o    uninstallOpts
	}{
		{"full uninstall", uninstallOpts{ufw: status}},
		{"--keep-cores", uninstallOpts{ufw: status, keepCores: true}},
		{"--reset", uninstallOpts{ufw: status, reset: true}},
	} {
		r := runUninstallWith(t, c.o)
		if r.err != nil {
			t.Fatalf("%s: %v\n%s", c.name, r.err, r.out)
		}
		if got := strings.Join(ufwDeletes(r.calls), " "); got != panel {
			t.Errorf("%s: ufw deleted %q, want %q:\n%s", c.name, got, panel, r.calls)
		}
		for _, kept := range []string{"9444", "94430", "9443/udp", "203.0.113.4", "192.0.2"} {
			if strings.Contains(r.calls, kept) {
				t.Errorf("%s: %s is not the agent's rule, but was touched:\n%s", c.name, kept, r.calls)
			}
		}
	}
}

// The forward policy an AmneziaWG install set is not put back (the customer's
// decision for 5.4: the uninstall cannot know what it was); the last message
// says so, and only when it was set.
func TestUninstallSaysItDoesNotRestoreTheForwardPolicy(t *testing.T) {
	r := runUninstallWith(t, uninstallOpts{forwardPolicy: "ACCEPT"})
	if r.err != nil || !strings.Contains(r.out, "Not restored: ufw's forward policy") || !strings.Contains(r.out, "DEFAULT_FORWARD_POLICY") {
		t.Errorf("%v\n%s", r.err, r.out)
	}
	if strings.Index(r.out, "Not restored") < strings.Index(r.out, "Removed: agent") {
		t.Errorf("the note comes before the summary:\n%s", r.out)
	}
	r = runUninstallWith(t, uninstallOpts{forwardPolicy: "DROP"})
	if r.err != nil || strings.Contains(r.out, "Not restored") {
		t.Errorf("a policy that was never changed is mentioned: %v\n%s", r.err, r.out)
	}
}
