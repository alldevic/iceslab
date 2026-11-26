package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// 5.4: what the node installer does before it touches the machine, and what it
// asks of the operator before it spends the one-shot bootstrap token. The
// order is: --help; the handover (A-282); the flags read; their values checked;
// root, banner, lock, apt; --uninstall; the question about a previous install;
// the token. Run for real where the script can be run without root (everything
// that is refused before the root check), cut out where it cannot.
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash.

const installLock = "/var/run/iceslab-node-install.lock"

type startRun struct {
	out, calls string
	err        error
}

// runInstallerArgs runs the real installer with args, the handover off and curl,
// apt-get, flock, dpkg, ufw and systemctl replaced by stand-ins that note their
// call. Only runs that end before the root check belong here: past it this
// would be an installer running as whoever runs the tests.
func runInstallerArgs(t *testing.T, env []string, args ...string) startRun {
	t.Helper()
	calls := filepath.Join(t.TempDir(), "calls")
	note := `echo "$(basename "$0") $*" >>'` + calls + "'\n"
	bin := stubs(t, map[string]string{
		"curl": note, "apt-get": note, "flock": note, "dpkg": note, "ufw": note, "systemctl": note,
	})
	cmd := exec.Command(needBash(t), append([]string{installerPath}, args...)...)
	cmd.Env = append([]string{"PATH=" + bin + ":/usr/bin:/bin", "ICESLAB_HANDOVER=off"}, env...)
	out, err := cmd.CombinedOutput()
	c, _ := os.ReadFile(calls)
	return startRun{out: string(out), calls: string(c), err: err}
}

func lockState() string {
	fi, err := os.Stat(installLock)
	if err != nil {
		return "absent"
	}
	return fi.ModTime().String()
}

func TestHelpAndATypoCostNothing(t *testing.T) {
	before := lockState()
	for _, c := range []struct {
		args []string
		env  []string
		ok   bool
		says string
	}{
		{[]string{"--help"}, nil, true, "--ssh-port"},
		{[]string{"-h"}, nil, true, "--engines"},
		// Looked at, not taken: wherever it stands among the flags.
		{[]string{"--engines", "xray", "--help"}, nil, true, "Usage"},
		// Before the handover: not asked for the installer of another ref (no
		// ICESLAB_HANDOVER=off here, the default ref is not this script's).
		{[]string{"--help"}, []string{"ICESLAB_HANDOVER="}, true, "--ssh-port"},
		{[]string{"--no-such-flag"}, nil, false, "Unknown arg: --no-such-flag"},
		{[]string{"--engines", "xray", "--port"}, nil, false, "unbound variable"},
	} {
		r := runInstallerArgs(t, c.env, c.args...)
		if c.ok != (r.err == nil) {
			t.Errorf("%v: exit %v:\n%s", c.args, r.err, r.out)
		}
		if !strings.Contains(r.out, c.says) {
			t.Errorf("%v: the output lacks %q:\n%s", c.args, c.says, r.out)
		}
		// No root asked for, no apt, no network, no lock.
		if strings.Contains(r.out, "Must run as root") || r.calls != "" {
			t.Errorf("%v: touched the machine (calls %q):\n%s", c.args, r.calls, r.out)
		}
	}
	if after := lockState(); after != before {
		t.Errorf("the install lock changed: %s -> %s", before, after)
	}
}

// A refused value costs neither root nor the token: the panel's curl is never
// called. Each of these is a run of the real script.
func TestARefusedFlagNeverReachesTheToken(t *testing.T) {
	panel := []string{"--panel-url", "https://panel.example.com", "--bootstrap", "bs_secret"}
	for _, c := range []struct {
		args []string
		says string
	}{
		{[]string{"--engines", "nope"}, "unknown core 'nope'"},
		{[]string{"--engines", "xray,xray"}, "named twice"},
		{[]string{"--engines", ""}, "names no core"},
		{[]string{"--protocol", "wireguard"}, "Unknown protocol: wireguard"},
		{[]string{"--engines", "xray", "--xray-port", "8443"}, "--xray-port needs --xray-reality-private-key"},
		{[]string{"--engines", "hysteria", "--xray-reality-private-key", "k"}, "--xray-reality-private-key: the REALITY pre-seed is written only on a node with xray"},
		{[]string{"--xray-reality-dest", "a.example:443", "--xray-port", "1"}, "--xray-reality-dest --xray-port"},
		{[]string{"--engines", "hysteria", "--hysteria-domain", "203.0.113.7"}, "not a name a public CA can issue for"},
		{[]string{"--ssh-port", "0"}, "out of range"},
		{[]string{"--ssh-port", "65536"}, "out of range"},
		{[]string{"--ssh-port", "22x"}, "must be a number"},
		{[]string{"--ssh-port", ""}, "must be a number"},
		{[]string{"--ssh-port", "-1"}, "must be a number"},
	} {
		r := runInstallerArgs(t, nil, append(append([]string{}, panel...), c.args...)...)
		if r.err == nil || !strings.Contains(r.out, c.says) {
			t.Errorf("%v: want a refusal saying %q, got %v:\n%s", c.args, c.says, r.err, r.out)
		}
		if strings.Contains(r.out, "Must run as root") {
			t.Errorf("%v: asked for root before refusing the flag:\n%s", c.args, r.out)
		}
		if r.calls != "" {
			t.Errorf("%v: reached the machine or the panel before the refusal:\n%s", c.args, r.calls)
		}
	}
}

// An accepted pre-seed (the key, with xray) gets past the checks to the root
// check, which is the first thing past them: nothing before it was spent.
func TestAnAcceptedPreseedReachesTheRootCheck(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("past the checks this would be a real install, as root")
	}
	r := runInstallerArgs(t, nil, "--engines", "xray", "--xray-reality-private-key", "k", "--xray-port", "8443")
	if !strings.Contains(r.out, "Must run as root") || r.calls != "" {
		t.Errorf("%v\n%s\n%s", r.err, r.out, r.calls)
	}
}

func TestInstallerSourceOrder(t *testing.T) {
	blob, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	at := func(re string) int {
		m := regexp.MustCompile(`(?m)` + re).FindStringIndex(s)
		if m == nil {
			t.Fatalf("no line matching %s", re)
		}
		return m[0]
	}
	order := []struct{ name, re string }{
		{"the --help look", `^    case "\$_arg" in -h\|--help\) print_help; exit 0 ;; esac$`},
		{"the handover", `^handover_to_ref "\$ICESLAB_NODE_REF" `},
		{"the flag parser", `^while \[\[ \$# -gt 0 \]\]; do$`},
		{"--ssh-port checked", `^    fail "--ssh-port out of range`},
		{"resolve_engines", `^  resolve_engines$`},
		{"check_hysteria_flags", `^  check_hysteria_flags$`},
		{"check_xray_flags", `^  check_xray_flags$`},
		{"the root check", `^\[\[ \$EUID -eq 0 \]\] \|\| fail`},
		{"the banner", `^banner$`},
		{"the lock", `^exec 9>`},
		{"wait_for_apt", `^wait_for_apt$`},
		{"the --uninstall fast path", `^if \[\[ \$UNINSTALL -eq 1 \]\]; then$`},
		{"the question about a previous install", `^confirm_reinstall$`},
		{"the token", `/api/internal/bootstrap/\$BOOTSTRAP_TOKEN`},
		{"the wipe", `^  do_uninstall$`},
		{"the first step", `^step "Prerequisites"$`},
	}
	last := -1
	for _, o := range order {
		i := at(o.re)
		if i < last {
			t.Errorf("%s is out of order (it is before the one above it)", o.name)
		}
		last = i
	}
	// The flag checks are install-only: --uninstall is not held up by them.
	check := regexp.MustCompile(`(?s)\nif \[\[ \$UNINSTALL -eq 0 \]\]; then\n(.*?)\nfi\n`).FindStringSubmatch(s)
	if check == nil {
		t.Fatal("no install-only block of flag checks")
	}
	for _, want := range []string{"--ssh-port must be a number", "resolve_engines", "check_hysteria_flags", "check_xray_flags"} {
		if !strings.Contains(check[1], want) {
			t.Errorf("the checks skipped by --uninstall lack %q", want)
		}
	}
}

// 4509d01c: a refused reinstall spent the operator's token, and a re-run with
// --reset then read "token already consumed". The decision is asked ahead of the
// redemption; "no", an unreadable terminal and no terminal all stop there.
func TestARefusedReinstallNeverReachesTheToken(t *testing.T) {
	bash := needBash(t)
	dir := t.TempDir()
	calls := filepath.Join(dir, "calls")
	bin := stubs(t, map[string]string{"curl": `echo "curl $*" >>'` + calls + "'\n"})
	n := 0
	answer := func(content string) string {
		n++
		p := filepath.Join(dir, "tty"+strconv.Itoa(n))
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	for _, c := range []struct {
		name, tty, vars string
		ok              bool
		says, notSays   string
	}{
		{"no", answer("n\n"), "", false, "Aborted by user", "Could not read"},
		{"nothing typed", answer("\n"), "", false, "Aborted by user", ""},
		{"yes", answer("y\n"), "", true, "", "Aborted"},
		{"YES", answer("YES\n"), "", true, "", "Aborted"},
		// The read fails: EOF here, ENXIO on an ssh without a terminal. Not a
		// person saying no.
		{"a read that fails", answer(""), "", false, "not an interactive session", "Aborted by user"},
		{"no terminal at all", filepath.Join(dir, "none"), "", false, "no /dev/tty for prompt", "Aborted by user"},
		{"--reset says yes in advance", answer(""), "RESET=1", true, "--reset given", "Aborted"},
		{"nothing installed", answer("n\n"), "EXISTING_INSTALL=0", true, "", "Aborted"},
	} {
		prog := "set -euo pipefail\nlog() { echo \"log: $*\"; }\nwarn() { :; }\nfail() { echo \"fail: $*\"; exit 1; }\n" +
			installerFunc(t, "confirm_reinstall") +
			"EXISTING_INSTALL=1\nRESET=0\nTTY_DEV='" + c.tty + "'\n" + c.vars + "\n" +
			"confirm_reinstall\ncurl --proto '=https' https://panel.example.com/api/internal/bootstrap/bs_secret\n"
		_ = os.Remove(calls)
		cmd := exec.Command(bash, "-c", prog)
		cmd.Env = []string{"PATH=" + bin + ":/usr/bin:/bin"}
		out, err := cmd.CombinedOutput()
		redeemed, _ := os.ReadFile(calls)
		if c.ok != (err == nil) || c.ok != (len(redeemed) > 0) {
			t.Errorf("%s: exit %v, curl calls %q:\n%s", c.name, err, redeemed, out)
		}
		if c.says != "" && !strings.Contains(string(out), c.says) {
			t.Errorf("%s: the output lacks %q:\n%s", c.name, c.says, out)
		}
		if c.notSays != "" && strings.Contains(string(out), c.notSays) {
			t.Errorf("%s: the output says %q:\n%s", c.name, c.notSays, out)
		}
		if !c.ok && !strings.Contains(string(out), "--reset") {
			t.Errorf("%s: the refusal does not name --reset:\n%s", c.name, out)
		}
	}
}

// What the flags do to ufw, run: the installer's firewall block with ufw
// replaced by a stand-in that notes its calls.
func firewallBlock(t *testing.T) string {
	t.Helper()
	blob, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	start := strings.Index(s, "\nstep \"Firewall (ufw)\"\n")
	end := strings.Index(s, "\n# ───── Optional: fail2ban ─────")
	if start == -1 || end == -1 || end < start {
		t.Fatal("the installer's firewall block is not where this test looks")
	}
	return s[start+len("\nstep \"Firewall (ufw)\"\n") : end]
}

// runFirewall runs the block with the given assignments; sshConn is the
// SSH_CONNECTION of the session ("" for none). It returns ufw's calls, one
// per line, and the output.
func runFirewall(t *testing.T, vars, sshConn string) (calls []string, out string) {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	bin := stubs(t, map[string]string{"ufw": `echo "$*" >>'` + log + "'\n"})
	defaults := filepath.Join(dir, "ufw-default")
	if err := os.WriteFile(defaults, []byte("DEFAULT_FORWARD_POLICY=\"DROP\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prog := "set -euo pipefail\nlog() { echo \"log: $*\"; }\nwarn() { echo \"warn: $*\"; }\n" +
		installerFunc(t, "find_ssh_connection") + "PROC_ROOT='" + dir + "/noproc'\n" +
		"SSH_PORT=22\nSSH_ALLOWLIST=''\nHARDEN_UFW=0\nPANEL_IP=''\nNODE_PORT=1337\nPROTOCOL=''\nENGINES=()\nUFW_DEFAULT_FILE='" + defaults + "'\n" +
		vars + "\n" + firewallBlock(t)
	cmd := exec.Command(needBash(t), "-c", prog)
	cmd.Env = []string{"PATH=" + bin + ":/usr/bin:/bin", "SSH_CONNECTION=" + sshConn}
	b, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, b)
	}
	c, _ := os.ReadFile(log)
	return strings.Split(strings.TrimSpace(string(c)), "\n"), string(b)
}

func sameCalls(t *testing.T, name string, got []string, want ...string) {
	t.Helper()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("%s: ufw was called\n  %s\nwant\n  %s", name, strings.Join(got, "\n  "), strings.Join(want, "\n  "))
	}
}

// Without --ssh-port the ufw calls are the base's, port 22 and nothing else.
func TestWithoutSshPortTheFirewallCallsAreTheBases(t *testing.T) {
	tail := []string{"allow 1337/tcp", "default deny incoming", "default allow outgoing", "--force enable", "status"}
	calls, _ := runFirewall(t, "", "")
	sameCalls(t, "plain", calls, append([]string{"allow 22/tcp"}, tail...)...)
	// A session that came in on 22 adds nothing either.
	calls, _ = runFirewall(t, "", "198.51.100.9 51000 192.0.2.1 22")
	sameCalls(t, "plain, session on 22", calls, append([]string{"allow 22/tcp"}, tail...)...)

	calls, _ = runFirewall(t, "HARDEN_UFW=1", "")
	sameCalls(t, "hardened", calls, append([]string{"limit 22/tcp"}, tail...)...)

	calls, _ = runFirewall(t, "SSH_ALLOWLIST='203.0.113.4, 10.0.0.0/8'", "203.0.113.4 51000 192.0.2.1 22")
	sameCalls(t, "allowlist", calls,
		"allow from 203.0.113.4 to any port 22 proto tcp",
		"allow from 10.0.0.0/8 to any port 22 proto tcp",
		// The leftover world-open rule goes, after the narrow ones.
		"--force delete allow 22/tcp", "--force delete limit 22/tcp",
		"allow 1337/tcp", "default deny incoming", "default allow outgoing", "--force enable", "status")

	calls, _ = runFirewall(t, "HARDEN_UFW=1\nSSH_ALLOWLIST='203.0.113.4'", "203.0.113.4 51000 192.0.2.1 22")
	if calls[0] != "limit from 203.0.113.4 to any port 22 proto tcp" {
		t.Errorf("hardened allowlist: %v", calls)
	}
}

func TestSshPortIsInEveryRule(t *testing.T) {
	tail := []string{"allow 1337/tcp", "default deny incoming", "default allow outgoing", "--force enable", "status"}
	calls, _ := runFirewall(t, "SSH_PORT=2222", "")
	sameCalls(t, "plain", calls, append([]string{"allow 2222/tcp"}, tail...)...)

	calls, _ = runFirewall(t, "SSH_PORT=2222\nHARDEN_UFW=1", "")
	sameCalls(t, "hardened", calls, append([]string{"limit 2222/tcp"}, tail...)...)

	calls, out := runFirewall(t, "SSH_PORT=2222\nSSH_ALLOWLIST='203.0.113.4'\nHARDEN_UFW=1", "198.51.100.9 51000 192.0.2.1 2222")
	sameCalls(t, "allowlist", calls,
		"limit from 203.0.113.4 to any port 2222 proto tcp",
		// The session's address is not in the list: allowed, said out loud.
		"allow from 198.51.100.9 to any port 2222 proto tcp",
		"--force delete allow 2222/tcp", "--force delete limit 2222/tcp",
		"allow 1337/tcp", "default deny incoming", "default allow outgoing", "--force enable", "status")
	for _, want := range []string{"Restricting SSH 2222/tcp", "ufw delete allow from 198.51.100.9 to any port 2222 proto tcp"} {
		if !strings.Contains(out, want) {
			t.Errorf("the output lacks %q:\n%s", want, out)
		}
	}
	// Not one rule of the lot is for port 22.
	for _, c := range calls {
		if regexp.MustCompile(`\b22\b`).MatchString(c) {
			t.Errorf("a rule for 22 with --ssh-port 2222: %q", c)
		}
	}
}

// 369c43a5: the session's own port is evidence of where sshd listens, and a
// wrong --ssh-port must not end the session when ufw comes up.
func TestTheCurrentSessionsPortIsAllowedToo(t *testing.T) {
	tail := []string{"allow 1337/tcp", "default deny incoming", "default allow outgoing", "--force enable", "status"}
	// sshd on 2200, --ssh-port left at 22, no allowlist: world-open like the rest.
	calls, out := runFirewall(t, "", "198.51.100.9 51000 192.0.2.1 2200")
	sameCalls(t, "no allowlist", calls, append([]string{"allow 22/tcp", "allow 2200/tcp"}, tail...)...)
	if !strings.Contains(out, "arrived on port 2200, not the 22") {
		t.Errorf("the disagreement is not said:\n%s", out)
	}

	// With an allowlist the session's port is opened for its address only: the
	// world-open version would undo the allowlist on the run that asked for it.
	calls, _ = runFirewall(t, "SSH_ALLOWLIST='203.0.113.4'", "198.51.100.9 51000 192.0.2.1 2200")
	sameCalls(t, "allowlist", calls,
		"allow from 203.0.113.4 to any port 22 proto tcp",
		"allow from 198.51.100.9 to any port 22 proto tcp",
		"allow from 198.51.100.9 to any port 2200 proto tcp",
		"--force delete allow 22/tcp", "--force delete limit 22/tcp",
		"allow 1337/tcp", "default deny incoming", "default allow outgoing", "--force enable", "status")
	for _, c := range calls {
		if c == "allow 2200/tcp" {
			t.Errorf("the session's port was opened to the world beside an allowlist")
		}
	}

	// Nothing known about the session (console, serial, sudo without the
	// environment): no guessing. The leftover world-open rule is the only thing
	// keeping the operator in, so it stays, and the warning says so.
	calls, out = runFirewall(t, "SSH_ALLOWLIST='203.0.113.4'", "")
	sameCalls(t, "allowlist, unknown session", calls,
		"allow from 203.0.113.4 to any port 22 proto tcp",
		"allow 1337/tcp", "default deny incoming", "default allow outgoing", "--force enable", "status")
	if !strings.Contains(out, "no SSH_CONNECTION in the environment") || !strings.Contains(out, "ufw --force delete allow 22/tcp") {
		t.Errorf("the warning lacks what to do:\n%s", out)
	}

	// A port that is not a number is no evidence.
	calls, _ = runFirewall(t, "", "198.51.100.9 51000 192.0.2.1 x; reboot")
	sameCalls(t, "garbage port", calls, append([]string{"allow 22/tcp"}, tail...)...)
}

// The ports the uninstall takes off are the ones the firewall step opens for the
// cores, no more and no fewer.
func TestTheUninstallTakesOffTheProtocolPortsTheFirewallOpens(t *testing.T) {
	var opened []string
	for _, engines := range []string{"hysteria", "xray", "amneziawg", "naive", "mtproto", "mieru", "shadowsocks"} {
		calls, _ := runFirewall(t, "ENGINES=("+engines+")", "")
		for _, c := range calls {
			if m := regexp.MustCompile(`^allow (\d+/(?:tcp|udp))$`).FindStringSubmatch(c); m != nil && m[1] != "22/tcp" && m[1] != "1337/tcp" {
				opened = append(opened, m[1])
			}
		}
	}
	// --protocol shadowsocks beside --engines xray is the one that opens 443/udp
	// of xray, which does not.
	calls, _ := runFirewall(t, "PROTOCOL=shadowsocks\nENGINES=(xray)", "")
	for _, c := range calls {
		if m := regexp.MustCompile(`^allow (\d+/(?:tcp|udp))$`).FindStringSubmatch(c); m != nil && m[1] != "22/tcp" && m[1] != "1337/tcp" {
			opened = append(opened, m[1])
		}
	}
	sort.Strings(opened)
	var uniq []string
	for _, p := range opened {
		if len(uniq) == 0 || uniq[len(uniq)-1] != p {
			uniq = append(uniq, p)
		}
	}
	m := regexp.MustCompile(`(?m)^PROTOCOL_PORTS="([^"]*)"$`).FindStringSubmatch(readInstaller(t))
	if m == nil {
		t.Fatal("no PROTOCOL_PORTS")
	}
	listed := strings.Fields(m[1])
	sort.Strings(listed)
	if strings.Join(uniq, " ") != strings.Join(listed, " ") {
		t.Errorf("the firewall step opens %v, the uninstall takes off %v", uniq, listed)
	}
}

func readInstaller(t *testing.T) string {
	t.Helper()
	blob, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatal(err)
	}
	return string(blob)
}

// The jail watches the port the firewall opens: --ssh-port, 22 by default, the
// text of the base's jail otherwise untouched.
func TestTheJailFollowsSshPort(t *testing.T) {
	s := readInstaller(t)
	m := regexp.MustCompile("(?s)cat > /etc/fail2ban/jail\\.d/iceslab\\.local <<EOF\n(.*?)\nEOF\n").FindStringSubmatch(s)
	if m == nil {
		t.Fatal("the jail is not where this test looks")
	}
	for _, c := range []struct{ port, want string }{{"22", "port     = 22\n"}, {"2222", "port     = 2222\n"}} {
		out, err := exec.Command(needBash(t), "-c", "SSH_PORT="+c.port+"\ncat <<EOF\n"+m[1]+"\nEOF\n").CombinedOutput()
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if !strings.Contains(string(out), "[sshd]\nenabled  = true\n"+c.want) {
			t.Errorf("SSH_PORT=%s: the jail\n%s", c.port, out)
		}
		if c.port != "22" && regexp.MustCompile(`\b22\b`).Match(out) {
			t.Errorf("SSH_PORT=%s: the jail still names 22:\n%s", c.port, out)
		}
	}
}

// --help is the file's own header, and it is the list of flags the parser takes:
// each way round (it had drifted: --panel-ip, --port and a flag that took a
// value and did nothing with it were parsed and not named).
func TestHelpAndTheParserNameTheSameFlags(t *testing.T) {
	s := readInstaller(t)
	header := s[:strings.Index(s, "\nset -euo pipefail")]
	flag := regexp.MustCompile(`--[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:-\*)?`)
	inHelp := map[string]bool{}
	for _, f := range flag.FindAllString(header, -1) {
		// A prefix in prose (--hysteria-*) names a family, not a flag.
		if !strings.HasSuffix(f, "-*") {
			inHelp[f] = true
		}
	}
	loop := regexp.MustCompile(`(?s)\nwhile \[\[ \$# -gt 0 \]\]; do\n(.*?)\ndone\n`).FindStringSubmatch(s)
	if loop == nil {
		t.Fatal("no flag parser")
	}
	parsed := map[string]bool{}
	for _, arm := range regexp.MustCompile(`(?m)^    ((?:-[a-z]\|)?--[a-z0-9-]+)\)`).FindAllStringSubmatch(loop[1], -1) {
		for _, f := range flag.FindAllString(arm[1], -1) {
			parsed[f] = true
		}
	}
	if len(parsed) < 20 {
		t.Fatalf("read %d flags from the parser", len(parsed))
	}
	for f := range parsed {
		if !inHelp[f] {
			t.Errorf("%s is parsed and --help does not name it", f)
		}
	}
	// Prose may name a prefix (--hysteria-*) or a flag of another script.
	other := map[string]bool{"--remove": true}
	for f := range inHelp {
		if !parsed[f] && !other[f] {
			t.Errorf("--help names %s, which the parser does not take", f)
		}
	}
	if parsed["--xray-reality-public-key"] || inHelp["--xray-reality-public-key"] {
		t.Error("--xray-reality-public-key is back: it took a value nothing read")
	}
	// And the README's table.
	readme, err := os.ReadFile("../../README.md")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(readme), "xray-reality-public-key") {
		t.Error("README.md still names --xray-reality-public-key")
	}
	for _, f := range []string{"--ssh-port", "--ssh-allowlist", "--panel-ip", "--port", "--uninstall", "--help"} {
		if !strings.Contains(string(readme), "`"+f) {
			t.Errorf("README.md does not name %s", f)
		}
	}
}

// Every variable a flag assigns is read somewhere else: a flag that took a
// value nothing read (--xray-reality-public-key was one) answers "ok" to the
// operator and does nothing.
func TestEveryFlagVariableIsRead(t *testing.T) {
	s := readInstaller(t)
	loop := regexp.MustCompile(`(?s)\nwhile \[\[ \$# -gt 0 \]\]; do\n(.*?)\ndone\n`).FindStringSubmatch(s)
	if loop == nil {
		t.Fatal("no flag parser")
	}
	// Accepted so that a command an older panel printed still runs, and said
	// to do nothing in the header: the profile decides.
	acceptedAndUnused := map[string]bool{"HY_MASQUERADE_URL": true, "HY_OBFS_PASSWORD": true}
	rest := strings.Replace(s, loop[1], "", 1)
	assign := regexp.MustCompile(`\b([A-Z][A-Z0-9_]+)=`)
	seen := map[string]bool{}
	for _, m := range assign.FindAllStringSubmatch(loop[1], -1) {
		v := m[1]
		if seen[v] {
			continue
		}
		seen[v] = true
		read := regexp.MustCompile(`\$\{?` + v + `\b|\[\[ [^\n]*\b` + v + `\b|\$\(\(.*\b` + v + `\b`).MatchString(codeLines(rest))
		if acceptedAndUnused[v] {
			if read {
				t.Errorf("%s is read now: drop it from acceptedAndUnused", v)
			}
			continue
		}
		if !read {
			t.Errorf("a flag assigns %s and nothing reads it", v)
		}
	}
	if len(seen) < 20 {
		t.Fatalf("saw %d variables in the parser", len(seen))
	}
}

func TestTheInstallerParses(t *testing.T) {
	if out, err := exec.Command(needBash(t), "-n", installerPath).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}

// sudo drops SSH_CONNECTION: the session is then read from the nearest ancestor
// process that has it. Run against a fake /proc (PROC_ROOT).
func TestTheSessionIsFoundInAnAncestorsEnvironment(t *testing.T) {
	bash := needBash(t)
	run := func(env, ancestorEnv string) string {
		proc := t.TempDir()
		// 1 (init) <- 500 (sshd session) <- 600 (sudo) <- $$ is the shell under test.
		write := func(pid, ppid, environ string) {
			d := filepath.Join(proc, pid)
			if err := os.MkdirAll(d, 0o755); err != nil {
				t.Fatal(err)
			}
			os.WriteFile(filepath.Join(d, "status"), []byte("Name:\tx\nPPid:\t"+ppid+"\n"), 0o644)
			os.WriteFile(filepath.Join(d, "environ"), []byte(environ), 0o644)
		}
		write("600", "500", "PATH=/usr/bin\x00SUDO_USER=op\x00")
		write("500", "1", "HOME=/root\x00"+ancestorEnv)
		write("1", "0", "SSH_CONNECTION=9.9.9.9 1 2.2.2.2 1\x00")
		prog := "set -euo pipefail\n" + installerFunc(t, "find_ssh_connection") +
			"PROC_ROOT='" + proc + "'\n"
		// $$ of the program is not in the fake tree: start the walk at 600.
		prog = strings.Replace(prog, "local pid=$$", "local pid=600", 1) + "find_ssh_connection\n"
		cmd := exec.Command(bash, "-c", prog)
		cmd.Env = []string{"PATH=/usr/bin:/bin", "SSH_CONNECTION=" + env}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		return string(out)
	}
	// The ancestor's value is found (never pid 1's).
	if got := run("", "SSH_CONNECTION=198.51.100.9 51000 192.0.2.1 2200\x00"); got != "198.51.100.9 51000 192.0.2.1 2200" {
		t.Errorf("ancestor: %q", got)
	}
	// No ancestor has it: nothing (the walk stops before pid 1).
	if got := run("", ""); got != "" {
		t.Errorf("none: %q", got)
	}
	// The firewall block: the environment wins when set, the walk fills in when
	// not, and with neither the warning stays.
	calls, out := runFirewall(t, "SSH_ALLOWLIST='203.0.113.4'", "198.51.100.9 51000 192.0.2.1 2200")
	if !strings.Contains(strings.Join(calls, "\n"), "allow from 198.51.100.9 to any port 2200 proto tcp") {
		t.Errorf("env set: %v\n%s", calls, out)
	}
	_, out = runFirewall(t, "SSH_ALLOWLIST='203.0.113.4'\nfind_ssh_connection() { printf '198.51.100.9 51000 192.0.2.1 2200'; }", "")
	if !strings.Contains(out, "read it from the ssh session above") || strings.Contains(out, "no SSH_CONNECTION") {
		t.Errorf("walk used:\n%s", out)
	}
	_, out = runFirewall(t, "SSH_ALLOWLIST='203.0.113.4'\nfind_ssh_connection() { :; }\nSUDO_USER=op", "")
	if !strings.Contains(out, "no SSH_CONNECTION in the environment or in any parent process (run through sudo by op)") {
		t.Errorf("none:\n%s", out)
	}
}
