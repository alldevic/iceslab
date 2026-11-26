package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The hardening flags of the node installer, run: the ufw rules of --panel-ip
// and the allowlist (beside what installer_start_test.go has for --ssh-port and
// the session's own address), and the fail2ban block, which writes into a
// temporary directory through FAIL2BAN_DIR instead of /etc/fail2ban.
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash.

var fwTail = []string{"default deny incoming", "default allow outgoing", "--force enable", "status"}

func TestTheSshRuleIsInPlaceBeforeUfwIsEnabled(t *testing.T) {
	for _, vars := range []string{"", "HARDEN_UFW=1", "SSH_PORT=2222", "SSH_ALLOWLIST='203.0.113.4'\nHARDEN_UFW=1"} {
		calls, _ := runFirewall(t, vars, "203.0.113.4 51000 192.0.2.1 22")
		enable := at(strings.Join(calls, "\n")+"\n", "--force enable")
		ssh := -1
		for i, c := range calls {
			if strings.Contains(c, "port 22 ") || strings.Contains(c, "port 2222 ") || c == "allow 22/tcp" || c == "limit 22/tcp" || c == "allow 2222/tcp" || c == "limit 2222/tcp" {
				ssh = i
				break
			}
		}
		if enable == -1 || ssh == -1 || calls[0] != calls[ssh] {
			t.Errorf("%q: the first ufw call is %q, ssh rule at %d, calls %v", vars, calls[0], ssh, calls)
		}
		if calls[len(calls)-2] != "--force enable" {
			t.Errorf("%q: ufw is enabled out of its place: %v", vars, calls)
		}
	}
}

func TestPanelIpOpensTheAgentPortToThePanelOnly(t *testing.T) {
	calls, out := runFirewall(t, "PANEL_IP='198.51.100.7, 198.51.100.8'", "")
	sameCalls(t, "panel ip list", calls, append([]string{"allow 22/tcp",
		"allow from 198.51.100.7 to any port 1337 proto tcp",
		"allow from 198.51.100.8 to any port 1337 proto tcp"}, fwTail...)...)
	if strings.Contains(out, "WORLD") {
		t.Errorf("the world-open warning with --panel-ip:\n%s", out)
	}

	// Without it the port is open to everyone, and the output says so.
	calls, out = runFirewall(t, "", "")
	if !strings.Contains(strings.Join(calls, "\n"), "allow 1337/tcp") || !strings.Contains(out, "opened to the WORLD") {
		t.Errorf("no --panel-ip: %v\n%s", calls, out)
	}

	// An empty entry in the list makes no rule.
	calls, _ = runFirewall(t, "PANEL_IP='198.51.100.7, ,'", "")
	sameCalls(t, "empty panel entry", calls, append([]string{"allow 22/tcp", "allow from 198.51.100.7 to any port 1337 proto tcp"}, fwTail...)...)
}

func TestAllowlistLeavesNoOpenSshRule(t *testing.T) {
	session := "203.0.113.4 51000 192.0.2.1 22"
	for _, harden := range []string{"0", "1"} {
		verb := map[string]string{"0": "allow", "1": "limit"}[harden]
		calls, _ := runFirewall(t, "HARDEN_UFW="+harden+"\nSSH_ALLOWLIST='203.0.113.4,10.0.0.0/8'", session)
		for _, c := range calls[:3] {
			if c == "allow 22/tcp" || c == "limit 22/tcp" {
				t.Errorf("harden=%s: a world-open ssh rule before the deletes: %v", harden, calls)
			}
		}
		sameCalls(t, "allowlist harden="+harden, calls, append([]string{
			verb + " from 203.0.113.4 to any port 22 proto tcp",
			verb + " from 10.0.0.0/8 to any port 22 proto tcp",
			"--force delete allow 22/tcp", "--force delete limit 22/tcp", "allow 1337/tcp"}, fwTail...)...)
	}
	// A blank entry gives no rule, not `from  to any`.
	calls, _ := runFirewall(t, "SSH_ALLOWLIST='203.0.113.4, ,'", session)
	for _, c := range calls {
		if strings.Contains(c, "from  ") || strings.Contains(c, "from to") {
			t.Errorf("a rule with no address: %q", c)
		}
	}
	if n := strings.Count(strings.Join(calls, "\n"), "port 22 proto tcp"); n != 1 {
		t.Errorf("one address, %d rules: %v", n, calls)
	}
}

func TestAnAddressOutsideTheAllowlistIsAllowedAndSaid(t *testing.T) {
	calls, out := runFirewall(t, "SSH_ALLOWLIST='203.0.113.4'", "198.51.100.9 51000 192.0.2.1 22")
	if !strings.Contains(strings.Join(calls, "\n"), "allow from 198.51.100.9 to any port 22 proto tcp") {
		t.Errorf("the session's address got no rule: %v", calls)
	}
	if !strings.Contains(out, "warn: current SSH IP 198.51.100.9 is NOT in --ssh-allowlist") {
		t.Errorf("no warning:\n%s", out)
	}
	// An address that is in the list gets no extra rule and no warning.
	calls, out = runFirewall(t, "SSH_ALLOWLIST='198.51.100.9, 203.0.113.4'", "198.51.100.9 51000 192.0.2.1 22")
	if strings.Contains(out, "NOT in --ssh-allowlist") || strings.Count(strings.Join(calls, "\n"), "from 198.51.100.9") != 1 {
		t.Errorf("an address in the list: %v\n%s", calls, out)
	}
}

// --- fail2ban ---

func fail2banBlock(t *testing.T) string {
	t.Helper()
	s := readInstaller(t)
	start := strings.Index(s, "\n# ───── Optional: fail2ban ─────\n")
	end := strings.Index(s, "\nstep \"systemd unit + start\"")
	if start == -1 || end == -1 || end < start {
		t.Fatal("the installer's fail2ban block is not where this test looks")
	}
	return s[start:end]
}

type f2bRun struct {
	root, calls, out string
}

// runFail2ban runs the block with apt-get, systemctl and fail2ban-client
// stubbed, FAIL2BAN_DIR in a temp directory holding `pre` (path -> content).
func runFail2ban(t *testing.T, flag string, port string, pre map[string]string) f2bRun {
	t.Helper()
	dir := t.TempDir()
	root := filepath.Join(dir, "fail2ban")
	for p, c := range pre {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, p)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, p), []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	log := filepath.Join(dir, "calls")
	note := `echo "$(basename "$0") $*" >>'` + log + "'\n"
	bin := stubs(t, map[string]string{"apt-get": note, "systemctl": note, "fail2ban-client": note + "echo 'Jail list: sshd, iceslab-hysteria'\n"})
	prog := "set -euo pipefail\nlog() { echo \"log: $*\"; }\nwarn() { echo \"warn: $*\"; }\n" +
		"APT_ENV=(env); APT_OPTS=(-o x=y)\nFAIL2BAN=" + flag + "\nSSH_PORT=" + port + "\nFAIL2BAN_DIR='" + root + "'\n" + fail2banBlock(t)
	cmd := exec.Command(needBash(t), "-c", prog)
	cmd.Env = []string{"PATH=" + bin + ":/usr/bin:/bin"}
	b, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, b)
	}
	c, _ := os.ReadFile(log)
	return f2bRun{root: root, calls: string(c), out: string(b)}
}

func TestFail2banWritesTheJailAndTheFilter(t *testing.T) {
	r := runFail2ban(t, "1", "2222", nil)
	jail, err := os.ReadFile(filepath.Join(r.root, "jail.d", "iceslab.local"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"[DEFAULT]\nbackend  = systemd\n", "[sshd]\nenabled  = true\nport     = 2222\n", "[iceslab-hysteria]\nenabled  = true\nfilter   = iceslab-hysteria\n"} {
		if !strings.Contains(string(jail), want) {
			t.Errorf("the jail lacks %q:\n%s", want, jail)
		}
	}
	filter, err := os.ReadFile(filepath.Join(r.root, "filter.d", "iceslab-hysteria.conf"))
	if err != nil {
		t.Fatal(err)
	}
	// The expression is what the agent logs for a refused client, and <HOST> is
	// where fail2ban takes the address from.
	if !strings.Contains(string(filter), `failregex = "msg":"hysteria auth rejected","addr":"<HOST>(?::\d+)?"`) ||
		!strings.Contains(string(filter), "journalmatch = _SYSTEMD_UNIT=iceslab-node.service") {
		t.Errorf("the filter:\n%s", filter)
	}
	for _, want := range []string{"apt-get -o x=y install -y fail2ban", "systemctl enable fail2ban", "systemctl restart fail2ban"} {
		if !strings.Contains(r.calls, want) {
			t.Errorf("no call %q in\n%s", want, r.calls)
		}
	}
	if !strings.Contains(r.out, "jails: sshd, iceslab-hysteria") {
		t.Errorf("the jails are not reported:\n%s", r.out)
	}
}

func TestFail2banLeavesTheOperatorsFilesAlone(t *testing.T) {
	pre := map[string]string{
		"jail.local":                  "[sshd]\nmaxretry = 3\n",
		"jail.d/defaults-debian.conf": "[sshd]\nenabled = true\n",
		"filter.d/sshd.conf":          "[Definition]\n",
	}
	r := runFail2ban(t, "1", "22", pre)
	for p, want := range pre {
		got, err := os.ReadFile(filepath.Join(r.root, p))
		if err != nil || string(got) != want {
			t.Errorf("%s changed: %q, %v", p, got, err)
		}
	}
	var entries []string
	_ = filepath.WalkDir(r.root, func(p string, d os.DirEntry, _ error) error {
		if !d.IsDir() {
			entries = append(entries, p)
		}
		return nil
	})
	if len(entries) != 5 {
		t.Errorf("expected the three files of the operator and our two, found %v", entries)
	}
}

func TestWithoutTheFlagFail2banIsNotTouched(t *testing.T) {
	r := runFail2ban(t, "0", "22", nil)
	if _, err := os.Stat(r.root); err == nil || r.calls != "" {
		t.Errorf("FAIL2BAN=0 did something: %q", r.calls)
	}
}

// FAIL2BAN_DIR exists so the block can run here; it is /etc/fail2ban unless a
// test says otherwise, and the block names no other path.
func TestFail2banWritesToEtcByDefault(t *testing.T) {
	if m := regexp.MustCompile(`(?m)^FAIL2BAN_DIR=(\S+)$`).FindStringSubmatch(readInstaller(t)); m == nil || m[1] != "/etc/fail2ban" {
		t.Errorf("FAIL2BAN_DIR is not set to /etc/fail2ban at the top level: %v", m)
	}
	if m := regexp.MustCompile(`(?m)^\s*(?:install -d|cat >|rm -f)[^#\n]*/etc/fail2ban`).FindString(fail2banBlock(t)); m != "" {
		t.Errorf("the block writes to a literal /etc/fail2ban: %q", m)
	}
}

// --- the unit and the directories the cores write ---

// ProtectSystem=strict makes /etc read-only except for ReadWritePaths, which
// cannot create a directory: so every directory the installer makes for a core's
// config is in ReadWritePaths, or the core's write fails on a running node.
func TestEveryCoreConfigDirIsInReadWritePaths(t *testing.T) {
	s := readInstaller(t)
	mk := regexp.MustCompile(`(?m)^mkdir -p (/etc/\S+(?: /etc/\S+)+)\s*$`).FindStringSubmatch(s)
	rw := regexp.MustCompile(`(?m)^ReadWritePaths=(.*)$`).FindStringSubmatch(s)
	if mk == nil || rw == nil {
		t.Fatal("the mkdir of the core directories or ReadWritePaths is not where this test looks")
	}
	dirs := strings.Fields(mk[1])
	if len(dirs) < 7 {
		t.Fatalf("expected at least 7 core directories, found %v", dirs)
	}
	listed := map[string]bool{}
	for _, p := range strings.Fields(rw[1]) {
		listed[strings.TrimPrefix(p, "-")] = true
	}
	for _, d := range dirs {
		if !listed[d] {
			t.Errorf("%s is created for a core and is not in ReadWritePaths", d)
		}
	}
}
