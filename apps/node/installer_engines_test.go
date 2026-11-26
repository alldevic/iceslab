package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// --engines in install-iceslab-node.sh, run for real: the installer's "Cores"
// section cut out of the script and run in bash against a fake checkout whose
// bootstraps are stand-ins that note their call and write a block through the
// real lib/node-env.sh. Same shape as the installer test in
// internal/payload/coreenv_test.go.
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash.

const installerPath = "../../scripts/install-iceslab-node.sh"

// coresSection is the installer from KNOWN_ENGINES to the end of
// legacy_primary_env: every function --engines is made of.
func coresSection(t *testing.T) string {
	t.Helper()
	blob, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	start := strings.Index(s, "\nKNOWN_ENGINES=")
	last := strings.Index(s, "\nlegacy_primary_env() {")
	if start == -1 || last == -1 {
		t.Fatal("the installer's Cores section is not where this test looks")
	}
	end := strings.Index(s[last:], "\n}\n")
	return s[start : last+end+3]
}

type installRun struct {
	out, calls, env string
	err             error
}

// runInstall builds a checkout (with or without lib/node-env.sh), runs
// resolve_engines, install_engines and core_flags_env, and returns what
// happened.
func runInstall(t *testing.T, withLib bool, protocol, engines string, withSingbox bool) installRun {
	return runInstallWith(t, withLib, protocol, engines, withSingbox, "")
}

// runInstallWith is runInstall with shell assignments of the install flags
// (HY_DOMAIN=..., XR_PRIVATE_KEY=...) set before the run.
func runInstallWith(t *testing.T, withLib bool, protocol, engines string, withSingbox bool, flags string) installRun {
	t.Helper()
	bash := needBash(t)
	root := t.TempDir()
	scripts := filepath.Join(root, "apps", "node", "scripts")
	if err := os.MkdirAll(filepath.Join(scripts, "lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	if withLib {
		lib, err := os.ReadFile(filepath.Join("scripts", "lib", "node-env.sh"))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(scripts, "lib", "node-env.sh"), lib, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for engine, name := range bootstraps {
		stub := "#!/usr/bin/env bash\nset -euo pipefail\necho \"" + name + " $*\" >>\"$CALLS\"\n" +
			// FAIL_CORE names a core whose bootstrap refuses, as bootstrap-mieru did on nl-01.
			"if [[ \"${FAIL_CORE:-}\" == " + engine + " ]]; then printf '\\033[1;31m[fail]\\033[0m %s\\n' \"" + engine + " broke\" >&2; exit 1; fi\n"
		if withLib {
			stub += ". \"$(dirname \"$0\")/lib/node-env.sh\"\nnode_env_block " + engine + " STUB_" + strings.ToUpper(engine) + "=1\n"
		}
		if err := os.WriteFile(filepath.Join(scripts, name), []byte(stub), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	env := filepath.Join(root, "env")
	calls := filepath.Join(root, "calls")
	if err := os.WriteFile(env, []byte("NODE_PAYLOAD=x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ws := "0"
	if withSingbox {
		ws = "1"
	}
	prog := "set -euo pipefail\nlog() { :; }\nwarn() { echo \"warn: $*\"; }\nfail() { echo \"fail: $*\"; exit 1; }\n" +
		coresSection(t) + "\n" +
		"ICESLAB_NODE_DIR='" + root + "'\nICESLAB_NODE_REF=v0.1.9\nENV_FILE='" + env + "'\nHY_DOMAIN=''\nHY_EMAIL=''\n" +
		"XR_PRIVATE_KEY=''\nXR_SHORT_IDS=''\nXR_SERVER_NAMES='www.cloudflare.com'\nXR_DEST='www.cloudflare.com:443'\nXR_PORT=443\nENGINES_GIVEN=0\n" +
		flags + "\n" +
		"PROTOCOL='" + protocol + "'\nENGINES_ARG='" + engines + "'\nWITH_SINGBOX=" + ws + "\n" +
		"resolve_engines\ninstall_engines \"$ICESLAB_NODE_DIR/apps/node/scripts\"\ncore_flags_env\necho \"ENGINES=${ENGINES[*]}\"\n" +
		"echo \"INSTALLED=${INSTALLED_ENGINES[*]}\"\necho \"FAILED=${FAILED_ENGINES[*]}\"\ncores_summary\n"
	cmd := exec.Command(bash, "-c", prog)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "ICESLAB_NODE_ENV=" + env, "CALLS=" + calls}
	out, err := cmd.CombinedOutput()
	c, _ := os.ReadFile(calls)
	e, _ := os.ReadFile(env)
	return installRun{out: string(out), calls: string(c), env: string(e), err: err}
}

func TestInstallerRunsEveryCoresBootstrapAndEachWiresItself(t *testing.T) {
	r := runInstall(t, true, "xray", "xray,hysteria,singbox", false)
	if r.err != nil {
		t.Fatalf("%v\n%s", r.err, r.out)
	}
	want := "bootstrap-xray.sh \nbootstrap-hysteria.sh \nbootstrap-singbox.sh \n"
	if r.calls != want {
		t.Errorf("calls:\n%s\nwant:\n%s", r.calls, want)
	}
	for _, engine := range []string{"xray", "hysteria", "singbox"} {
		if !strings.Contains(r.env, "# >>> iceslab-node env:"+engine+" >>>\nSTUB_"+strings.ToUpper(engine)+"=1\n") {
			t.Errorf("no %s block in the env:\n%s", engine, r.env)
		}
	}
	// The installer passes no --restart-agent: it starts the agent itself, once.
	if strings.Contains(r.calls, "--restart-agent") {
		t.Error("the installer asked a bootstrap to restart the agent")
	}
}

func TestInstallerTakesTheOldSpellingsToo(t *testing.T) {
	// --with-singbox on top of the main core, and a protocol whose core is
	// named differently (shadowsocks runs on xray).
	r := runInstall(t, true, "shadowsocks", "", true)
	if r.err != nil || !strings.Contains(r.out, "ENGINES=xray singbox") {
		t.Fatalf("%v\n%s", r.err, r.out)
	}
	if r.calls != "bootstrap-xray.sh \nbootstrap-singbox.sh \n" {
		t.Errorf("calls:\n%s", r.calls)
	}
	// Nothing named at all: the core of --protocol alone.
	r = runInstall(t, true, "tuic", "", false)
	if r.err != nil || r.calls != "bootstrap-singbox.sh \n" {
		t.Errorf("tuic alone: %v\n%s\n%s", r.err, r.calls, r.out)
	}
}

// 25.09: a node's cores are a set, none of them the main one. --engines alone
// installs them in any order, and the flags follow the core they belong to.
func TestInstallerTakesTheSetAndTheFlagsFollowTheirCore(t *testing.T) {
	r := runInstallWith(t, true, "", "hysteria,xray", false,
		"HY_DOMAIN='hy.example.com'\nHY_EMAIL='ops@example.com'\nXR_PRIVATE_KEY='priv'\nXR_SHORT_IDS='ab12'")
	if r.err != nil {
		t.Fatalf("%v\n%s", r.err, r.out)
	}
	if r.calls != "bootstrap-hysteria.sh \nbootstrap-xray.sh \n" {
		t.Errorf("calls:\n%s", r.calls)
	}
	for _, want := range []string{
		"HYSTERIA_HOSTNAME=hy.example.com\n",
		"HYSTERIA_ACME_EMAIL=ops@example.com\n",
		"XRAY_REALITY_PRIVATE_KEY=priv\n",
		"XRAY_REALITY_SHORT_IDS=ab12\n",
	} {
		if !strings.Contains(r.env, want) {
			t.Errorf("the env lacks %q:\n%s", want, r.env)
		}
	}

	// The private key alone pre-fills (the agent asks for nothing else): short
	// ids may be empty, a REALITY client sending an empty short id.
	r = runInstallWith(t, true, "", "xray", false, "XR_PRIVATE_KEY='priv'")
	if r.err != nil {
		t.Fatalf("%v\n%s", r.err, r.out)
	}
	for _, want := range []string{
		"XRAY_REALITY_PRIVATE_KEY=priv\n",
		"XRAY_REALITY_SHORT_IDS=\n",
		"XRAY_REALITY_SERVER_NAMES=www.cloudflare.com\n",
		"XRAY_PORT=443\n",
	} {
		if !strings.Contains(r.env, want) {
			t.Errorf("the key alone: the env lacks %q:\n%s", want, r.env)
		}
	}
	// No key, nothing: short ids alone are not a pre-seed.
	r = runInstallWith(t, true, "", "xray", false, "XR_SHORT_IDS='ab12'")
	if r.err != nil || strings.Contains(r.env, "XRAY_REALITY_") {
		t.Errorf("short ids without a key wrote a block: %v\n%s", r.err, r.env)
	}

	// A flag of a core the node does not get writes nothing.
	r = runInstallWith(t, true, "", "xray", false, "HY_DOMAIN='hy.example.com'\nHY_EMAIL='ops@example.com'")
	if r.err != nil || strings.Contains(r.env, "HYSTERIA_") {
		t.Errorf("a hysteria flag on an xray node: %v\n%s", r.err, r.env)
	}

	// --protocol beside --engines adds its core, wherever the list puts it:
	// no "main core goes first" any more.
	r = runInstall(t, true, "xray", "hysteria,xray", false)
	if r.err != nil || !strings.Contains(r.out, "ENGINES=xray hysteria") {
		t.Errorf("--protocol xray --engines hysteria,xray: %v\n%s", r.err, r.out)
	}
}

// E32, 25.09 on nl-01: mieru's bootstrap failed and set -e ended the install
// there, the agent's unit and the cores after it never went on. A failed core
// is now collected: the others still install, and the summary names it, why,
// and the command that adds it later.
func TestAFailedCoreDoesNotStopTheOthers(t *testing.T) {
	r := runInstallWith(t, true, "", "xray,mieru,mtproto", false, "export FAIL_CORE=mieru")
	if r.err != nil {
		t.Fatalf("install_engines ended the install: %v\n%s", r.err, r.out)
	}
	if r.calls != "bootstrap-xray.sh \nbootstrap-mieru.sh \nbootstrap-mtg.sh \n" {
		t.Errorf("calls:\n%s", r.calls)
	}
	for _, want := range []string{
		"INSTALLED=xray mtproto\n",
		"FAILED=mieru\n",
		"  Cores        xray mtproto\n",
		"  FAILED       mieru: [fail] mieru broke\n",
		"install later: sudo bash " + "",
		"/apps/node/scripts/bootstrap-mieru.sh --restart-agent\n",
	} {
		if !strings.Contains(r.out, want) {
			t.Errorf("the output lacks %q:\n%s", want, r.out)
		}
	}
	// The cores that went on wired themselves; the failed one did not.
	if strings.Contains(r.env, "env:mieru") || !strings.Contains(r.env, "env:mtproto") {
		t.Errorf("env:\n%s", r.env)
	}
}

// A command an older panel printed keeps working: --protocol hysteria is
// --engines hysteria, calls and env alike.
func TestProtocolAloneIsTheSetOfItsCore(t *testing.T) {
	flags := "HY_DOMAIN='hy.example.com'\nHY_EMAIL='ops@example.com'"
	old := runInstallWith(t, true, "hysteria", "", false, flags)
	set := runInstallWith(t, true, "", "hysteria", false, flags)
	if old.err != nil || set.err != nil {
		t.Fatalf("%v %v\n%s\n%s", old.err, set.err, old.out, set.out)
	}
	if old.calls != set.calls || old.env != set.env {
		t.Errorf("--protocol hysteria and --engines hysteria differ:\ncalls %q / %q\nenv:\n%s\n---\n%s", old.calls, set.calls, old.env, set.env)
	}
	if !strings.Contains(old.env, "HYSTERIA_HOSTNAME=hy.example.com\n") {
		t.Errorf("--protocol hysteria lost its flags:\n%s", old.env)
	}
}

// 25.09: a node may run no core at all. Nothing named installs the agent
// alone: no bootstrap runs, the env holds what this install wrote and nothing
// of a core.
func TestNothingNamedInstallsTheAgentAlone(t *testing.T) {
	for _, withLib := range []bool{true, false} {
		r := runInstallWith(t, withLib, "", "", false, "HY_DOMAIN='hy.example.com'\nHY_EMAIL='ops@example.com'")
		if r.err != nil {
			t.Fatalf("withLib=%v: %v\n%s", withLib, r.err, r.out)
		}
		if r.calls != "" {
			t.Errorf("withLib=%v: a bootstrap ran:\n%s", withLib, r.calls)
		}
		if r.env != "NODE_PAYLOAD=x\n" {
			t.Errorf("withLib=%v: the env got more than the install's own:\n%s", withLib, r.env)
		}
		if !strings.Contains(r.out, "ENGINES=\n") {
			t.Errorf("withLib=%v: the set is not empty:\n%s", withLib, r.out)
		}
	}
}

// Plain WireGuard goes on by either spelling, the same bootstrap, the same env
// block: --engines wireguard, and the older --protocol wireguard. It is its own
// core, not amneziawg's: the two names run side by side.
func TestInstallerInstallsWireguardByEitherSpelling(t *testing.T) {
	byEngine := runInstall(t, true, "", "wireguard", false)
	byProtocol := runInstall(t, true, "wireguard", "", false)
	both := runInstall(t, true, "wireguard", "amneziawg", false)
	for name, r := range map[string]installRun{"--engines": byEngine, "--protocol": byProtocol, "both": both} {
		if r.err != nil {
			t.Fatalf("%s: %v\n%s", name, r.err, r.out)
		}
		if !strings.Contains(r.calls, "bootstrap-wireguard.sh \n") {
			t.Errorf("%s: bootstrap-wireguard.sh did not run:\n%s", name, r.calls)
		}
		if !strings.Contains(r.env, "# >>> iceslab-node env:wireguard >>>\nSTUB_WIREGUARD=1\n") {
			t.Errorf("%s: no wireguard block in the env:\n%s", name, r.env)
		}
	}
	if byEngine.calls != "bootstrap-wireguard.sh \n" || byEngine.calls != byProtocol.calls || byEngine.env != byProtocol.env {
		t.Errorf("--engines wireguard and --protocol wireguard differ:\ncalls %q / %q\nenv:\n%s\n---\n%s",
			byEngine.calls, byProtocol.calls, byEngine.env, byProtocol.env)
	}
	if strings.Contains(byEngine.calls, "amneziawg") {
		t.Errorf("wireguard pulled the AmneziaWG bootstrap in:\n%s", byEngine.calls)
	}
	if !strings.Contains(both.calls, "bootstrap-amneziawg.sh") || !strings.Contains(both.calls, "bootstrap-wireguard.sh") {
		t.Errorf("both cores were named and one is missing:\n%s", both.calls)
	}
}

func TestInstallerRefusesAnUnusableSet(t *testing.T) {
	for _, c := range []struct{ protocol, engines, flags, says string }{
		{"xray", "xray,xray", "", "named twice"},
		{"xray", "xray,wireguardx", "", "unknown core 'wireguardx'"},
		{"", ",", "", "names no core"},
		// --engines '' names a list and puts nothing in it: a typo, not a choice.
		{"", "", "ENGINES_GIVEN=1", "names no core"},
	} {
		r := runInstallWith(t, true, c.protocol, c.engines, false, c.flags)
		if r.err == nil || !strings.Contains(r.out, c.says) {
			t.Errorf("%s/%s: want a refusal saying %q, got %v\n%s", c.protocol, c.engines, c.says, r.err, r.out)
		}
		if r.calls != "" {
			t.Errorf("%s/%s: a bootstrap ran before the refusal:\n%s", c.protocol, c.engines, r.calls)
		}
	}
}

// A-276: the e-mail is optional, the agent asks for the certificate without
// one. An address Let's Encrypt refuses (invalidContact) is refused before the
// bootstrap token is spent, not on the first push in the journal.
func TestHysteriaFlagsAreCheckedBeforeTheInstall(t *testing.T) {
	bash := needBash(t)
	for _, c := range []struct {
		domain, email string
		refused       bool
		says          string
	}{
		{"hy.iceslab.dev", "", false, "without an e-mail"},
		{"hy.iceslab.dev", "ops@iceslab.dev", false, ""},
		{"", "ops@iceslab.dev", false, "does nothing"},
		{"", "", false, ""},
		// What the panel put in before A-276 when ACME_DEFAULT_EMAIL was empty.
		{"hy.iceslab.dev", "admin@example.com", true, "refuses addresses at example.com"},
		{"hy.iceslab.dev", "ops@Example.ORG", true, "refuses addresses at example.org"},
		{"hy.iceslab.dev", "ops@example.net", true, "example.net"},
		{"hy.iceslab.dev", "root@localhost", true, "localhost"},
		{"hy.iceslab.dev", "root@box.localhost", true, "box.localhost"},
		{"hy.iceslab.dev", "ops", true, "not an e-mail address"},
		{"hy.iceslab.dev", "ops@", true, "not an e-mail address"},
		// A name no public CA issues for: the panel's command carries the node's
		// address, an IP for a node nobody has pointed DNS at.
		{"203.0.113.7", "", true, "not a name a public CA can issue for"},
		{"203.0.113.7", "ops@iceslab.dev", true, "an IP literal"},
		{"2001:db8::1", "", true, "not a name a public CA can issue for"},
		{"hy.iceslab.dev:443", "", true, "not a name a public CA can issue for"},
		{"hysteria", "", true, "single-label name"},
		{"hy1.iceslab.dev", "", false, "without an e-mail"},
	} {
		prog := "set -euo pipefail\nlog() { echo \"log: $*\"; }\nwarn() { echo \"warn: $*\"; }\nfail() { echo \"fail: $*\"; exit 1; }\n" +
			coresSection(t) + "\n" +
			"HY_DOMAIN='" + c.domain + "'\nHY_EMAIL='" + c.email + "'\ncheck_hysteria_flags\necho checked\n"
		out, err := exec.Command(bash, "-c", prog).CombinedOutput()
		s := string(out)
		if c.refused != (err != nil) || c.refused == strings.Contains(s, "checked") {
			t.Errorf("%q/%q: refused=%v want %v:\n%s", c.domain, c.email, err != nil, c.refused, s)
		}
		if c.says != "" && !strings.Contains(s, c.says) {
			t.Errorf("%q/%q: the output lacks %q:\n%s", c.domain, c.email, c.says, s)
		}
		if c.says == "" && strings.TrimSpace(s) != "checked" {
			t.Errorf("%q/%q: want no word, got:\n%s", c.domain, c.email, s)
		}
	}
}

// The check runs before the token is redeemed: a refused e-mail leaves the
// one-shot token unspent.
func TestHysteriaFlagsAreCheckedBeforeTheTokenIsRedeemed(t *testing.T) {
	blob, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	// Indented: the checks sit in the block --uninstall skips.
	check := regexp.MustCompile(`(?m)^\s*check_hysteria_flags$`).FindStringIndex(s)
	redeem := strings.Index(s, "/api/internal/bootstrap/$BOOTSTRAP_TOKEN")
	if check == nil || redeem == -1 || check[0] > redeem {
		t.Errorf("check_hysteria_flags at %v, the redemption at %d", check, redeem)
	}
}

// ab309130: the --xray-* flags reach one place, the REALITY block of a node with
// xray and a private key. Anywhere else they are refused by name, before the
// token (the hysteria flags on a node without hysteria stay a silent no-op, see
// above: a deliberate difference).
func TestXrayFlagsAreRefusedByNameWhereTheyCannotAct(t *testing.T) {
	bash := needBash(t)
	for _, c := range []struct {
		name, protocol, engines, given, key string
		refused                             bool
		says                                string
	}{
		{"no xray", "", "hysteria", " --xray-port", "", true, "--xray-port: the REALITY pre-seed is written only on a node with xray"},
		{"no xray, with a key", "", "hysteria", " --xray-reality-private-key", "k", true, "--xray-reality-private-key: the REALITY pre-seed"},
		{"no core at all", "", "", " --xray-reality-dest", "", true, "no core"},
		{"xray, no key", "", "xray", " --xray-port --xray-reality-short-ids", "", true, "--xray-port --xray-reality-short-ids needs --xray-reality-private-key"},
		{"xray and the key", "", "xray", " --xray-reality-private-key --xray-port", "k", false, ""},
		{"the key alone", "", "xray", " --xray-reality-private-key", "k", false, ""},
		{"shadowsocks runs on xray", "shadowsocks", "", " --xray-reality-private-key", "k", false, ""},
		{"no flag given", "", "hysteria", "", "", false, ""},
	} {
		prog := "set -euo pipefail\nlog() { :; }\nwarn() { :; }\nfail() { echo \"fail: $*\"; exit 1; }\n" + coresSection(t) + "\n" +
			"PROTOCOL='" + c.protocol + "'\nENGINES_ARG='" + c.engines + "'\nENGINES_GIVEN=0\nWITH_SINGBOX=0\n" +
			"XR_FLAGS_GIVEN='" + c.given + "'\nXR_PRIVATE_KEY='" + c.key + "'\nresolve_engines\ncheck_xray_flags\necho checked\n"
		out, err := exec.Command(bash, "-c", prog).CombinedOutput()
		if c.refused != (err != nil) || c.refused == strings.Contains(string(out), "checked") {
			t.Errorf("%s: refused=%v want %v:\n%s", c.name, err != nil, c.refused, out)
		}
		if c.says != "" && !strings.Contains(string(out), c.says) {
			t.Errorf("%s: the output lacks %q:\n%s", c.name, c.says, out)
		}
	}
}

func TestAnOldCheckoutGetsOneCoreAndAWarningThatSaysWhatFixesIt(t *testing.T) {
	r := runInstall(t, false, "xray", "xray,hysteria,singbox", false)
	if r.err != nil {
		t.Fatalf("%v\n%s", r.err, r.out)
	}
	if r.calls != "bootstrap-xray.sh \n" {
		t.Errorf("an old checkout ran more than the core of --protocol:\n%s", r.calls)
	}
	for _, want := range []string{
		"predates --engines",
		"NOT installed: hysteria singbox",
		"ICESLAB_NODE_REF=main",
		"fetch --depth 1 origin main",
		"bootstrap-<core>.sh --restart-agent",
		// A node whose Go is gone cannot rebuild the agent from any checkout
		// (ru-02 on the stand, 24.09): the warning says where Go comes from.
		"needs Go",
		"rerunning this installer",
	} {
		if !strings.Contains(r.out, want) {
			t.Errorf("the warning lacks %q:\n%s", want, r.out)
		}
	}
	// And that core is wired the old way, or the node would have none.
	if !strings.Contains(r.env, "XRAY_BINARY=/usr/local/bin/xray\n") {
		t.Errorf("the one core is not in the env:\n%s", r.env)
	}
}

// The installer's table and the panel's (ENGINE_BOOTSTRAP in shared) name the
// same script for every core: the panel's "how to install" and the installer
// are one road.
func TestInstallerAndPanelNameTheSameBootstraps(t *testing.T) {
	shared, err := os.ReadFile("../../packages/shared/src/core-versions.ts")
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)export const ENGINE_BOOTSTRAP[^{]*\{(.*?)\};`).FindSubmatch(shared)
	if block == nil {
		t.Fatal("ENGINE_BOOTSTRAP not found in core-versions.ts")
	}
	panel := map[string]string{}
	for _, m := range regexp.MustCompile(`(\w+): '([^']+)'`).FindAllSubmatch(block[1], -1) {
		panel[string(m[1])] = string(m[2])
	}
	section := coresSection(t)
	for engine, script := range panel {
		if !strings.Contains(section, engine+")") || !regexp.MustCompile(`\b`+engine+`\)\s+echo `+regexp.QuoteMeta(script)+` ;;`).MatchString(section) {
			t.Errorf("the installer does not map %s to %s", engine, script)
		}
		if bootstraps[engine] != script {
			t.Errorf("bootstrap_env_test knows %s as %q, the panel as %q", engine, bootstraps[engine], script)
		}
	}
	if len(panel) != len(bootstraps) {
		t.Errorf("the panel names %d cores, the tests %d", len(panel), len(bootstraps))
	}
}
