package zapret2

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The other half of the self-tune contract: the bash that writes the report.
//
// `deploy/ansible/roles/iceslab_node/files/iceslab-egress-selftune.sh` runs
// blockcheckw once per domain and joins the outputs with a separator, and this
// package splits on the same separator to parse them. The string is written out
// twice — SEP='===REPORT-SEP===' there, reportSeparator here — with nothing
// linking the two, and the way they fail apart is quiet: splitReports finds no
// separator, hands the whole file to extractJSONObject, which spans from the
// first '{' of the first report to the last '}' of the last one, and the result
// is not valid JSON. readTune logs one warning and returns nil, so the node
// keeps serving the panel's untuned strategy and the operator's only clue is a
// log line about an unusable report.
//
// So the script is not described here, it is run: a `docker` stub on PATH plays
// blockcheckw, the script writes a real file, and this package parses that file
// the way the agent does.

// repoFile walks up from the test's working directory to the repository root
// and returns the path to one of its files. The node module's root is apps/node
// and the ansible tree is outside it, so there is no import path to reach for.
func repoFile(t *testing.T, rel string) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "deploy", "ansible")); err == nil {
			p := filepath.Join(dir, rel)
			if _, err := os.Stat(p); err != nil {
				t.Fatalf("repository found at %s but %s is missing: %v", dir, rel, err)
			}
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("could not find the repository root above %s; the self-tune script cannot be read", dir)
	return ""
}

const selftuneScript = "deploy/ansible/roles/iceslab_node/files/iceslab-egress-selftune.sh"

// A report shaped like the one captured from a node behind RU DPI, with the
// http entry first so "the first TLS entry wins" is a claim about the parser
// rather than about the order the stub happened to print.
func reportFor(domain, args string) string {
	return `probing ` + domain + ` ...
{"domain":"` + domain + `","total":42,"working":2,"strategies":[` +
		`{"protocol":"HTTP","args":"--payload=http --lua-desync=split","coverage":0.5},` +
		`{"protocol":"HTTPS/TLS1.3","args":"` + args + `","coverage":1}]}
done`
}

// stubDocker puts a `docker` on PATH that answers `docker exec <c> blockcheckw
// scan -d <domain> ...` with whatever the caller wants for that domain, and
// records its argv so the flags the script sends can be read back.
func stubDocker(t *testing.T, reports map[string]string) (binDir, argvLog string) {
	t.Helper()
	binDir = t.TempDir()
	argvLog = filepath.Join(binDir, "argv.log")

	var cases strings.Builder
	for domain, body := range reports {
		cases.WriteString("    *' -d " + domain + " '*|*' -d " + domain + "') cat <<'REPORT'\n")
		cases.WriteString(body + "\nREPORT\n        ;;\n")
	}
	script := `#!/usr/bin/env bash
printf '%s\n' "$*" >> "` + argvLog + `"
case "$* " in
` + cases.String() + `    *) exit 1 ;;
esac
exit 0
`
	if err := os.WriteFile(filepath.Join(binDir, "docker"), []byte(script), 0o755); err != nil {
		t.Fatalf("write docker stub: %v", err)
	}
	return binDir, argvLog
}

func runSelftune(t *testing.T, binDir, tunePath string, env ...string) string {
	t.Helper()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Fatalf("bash is required to exercise the self-tune script: %v", err)
	}
	cmd := exec.Command("bash", repoFile(t, selftuneScript))
	cmd.Env = append(os.Environ(),
		"PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"),
		"ZAPRET2_TUNE_PATH="+tunePath,
	)
	cmd.Env = append(cmd.Env, env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("self-tune script failed: %v\n%s", err, out)
	}
	return string(out)
}

func TestSelftuneScriptWritesWhatThisPackageParses(t *testing.T) {
	const wantArgs = "--payload=tls_client_hello --lua-desync=tcpseg:pos=0,1:ip_id=rnd:repeats=1"
	binDir, argvLog := stubDocker(t, map[string]string{
		// The first domain has nothing to apply, so the winning strategy has to
		// come out of the SECOND report — which it can only do if the separator
		// the script writes is the one splitReports looks for.
		"example.com":   `{"domain":"example.com","total":0,"working":0,"strategies":[]}`,
		"rutracker.org": reportFor("rutracker.org", wantArgs),
	})
	tunePath := filepath.Join(t.TempDir(), "sub", "egress-tune.json")

	runSelftune(t, binDir, tunePath, "SELFTUNE_DOMAINS=example.com,rutracker.org")

	// Control: the script really wrote a file, with both scans in it. Without
	// this, a parse that returns nil would look like "the scan found nothing".
	raw, err := os.ReadFile(tunePath)
	if err != nil {
		t.Fatalf("the script wrote no report at %s: %v", tunePath, err)
	}
	if n := strings.Count(string(raw), reportSeparator); n != 2 {
		t.Fatalf("expected 2 separators between per-domain reports, found %d in:\n%s", n, raw)
	}
	if !strings.Contains(string(raw), "example.com") || !strings.Contains(string(raw), "rutracker.org") {
		t.Fatalf("both scans should be in the file, got:\n%s", raw)
	}

	tune, err := ParseBlockcheckReports(raw)
	if err != nil {
		t.Fatalf("the agent could not parse what the script wrote: %v\n%s", err, raw)
	}
	if tune == nil {
		t.Fatalf("no strategy came out of a report that has one:\n%s", raw)
	}
	if tune.Args != wantArgs {
		t.Errorf("args = %q, want %q", tune.Args, wantArgs)
	}
	if tune.Domain != "rutracker.org" {
		t.Errorf("domain = %q, want rutracker.org (the second report, reached only through the separator)", tune.Domain)
	}
	if tune.Working != 2 || tune.Total != 42 {
		t.Errorf("counts = %d/%d, want 2/42: the panel tells 'nothing was blocked' from 'nothing worked' with these", tune.Working, tune.Total)
	}

	// The flags are a contract with blockcheckw, and the only place they are
	// observable is the argv. --top decides how many strategies come back at
	// all; a scan without it is a report this parser reads the first line of.
	argv, err := os.ReadFile(argvLog)
	if err != nil {
		t.Fatalf("the stub recorded no calls, so the run above scanned nothing: %v", err)
	}
	for _, want := range []string{"blockcheckw scan", "--auto", "--top 1", "--timeout 120", "-d rutracker.org"} {
		if !strings.Contains(string(argv), want) {
			t.Errorf("blockcheckw was not asked for %q; argv was:\n%s", want, argv)
		}
	}

	// The agent polls this path, so a half-written file must never be visible:
	// the script writes a temp file beside it and renames. Nothing may be left.
	entries, _ := os.ReadDir(filepath.Dir(tunePath))
	for _, e := range entries {
		if e.Name() != filepath.Base(tunePath) {
			t.Errorf("the script left %s behind next to the report", e.Name())
		}
	}
}

func TestSelftuneScriptKeepsTheLastReportWhenAScanProducesNothing(t *testing.T) {
	// A container that is down answers nothing, and the script says so and
	// exits 0. What it must NOT do is overwrite the last usable report with an
	// empty one: the agent would stop applying a strategy that was working, and
	// nothing about the node's own state would have changed to explain it.
	binDir, _ := stubDocker(t, map[string]string{})
	dir := t.TempDir()
	tunePath := filepath.Join(dir, "egress-tune.json")
	previous := reportFor("rutracker.org", "--payload=tls_client_hello --lua-desync=split2")
	if err := os.WriteFile(tunePath, []byte(previous), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	out := runSelftune(t, binDir, tunePath, "SELFTUNE_DOMAINS=rutracker.org")

	raw, err := os.ReadFile(tunePath)
	if err != nil {
		t.Fatalf("the previous report is gone: %v", err)
	}
	if string(raw) != previous {
		t.Errorf("an empty scan replaced the last usable report:\n%s", raw)
	}
	if !strings.Contains(out, "leaving the last report in place") {
		t.Errorf("an empty scan passed without saying why; output was:\n%s", out)
	}
	// The control: the stub really refused, rather than the script never
	// reaching it.
	if !strings.Contains(out, "scanning rutracker.org") {
		t.Errorf("the script never got as far as scanning; output was:\n%s", out)
	}
}

func TestSelftuneScriptFixtureHookBypassesTheScan(t *testing.T) {
	// SELFTUNE_REPORT_FILE is how this path was exercised on a real node
	// without waiting for a scan. It is also the only way an operator can
	// replay a captured report, so it has to still reach the parser.
	binDir, argvLog := stubDocker(t, map[string]string{})
	dir := t.TempDir()
	fixture := filepath.Join(dir, "captured.json")
	const wantArgs = "--payload=tls_client_hello --lua-desync=fake,tcpseg"
	if err := os.WriteFile(fixture, []byte(reportFor("rutracker.org", wantArgs)), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	tunePath := filepath.Join(dir, "egress-tune.json")

	runSelftune(t, binDir, tunePath, "SELFTUNE_REPORT_FILE="+fixture)

	if _, err := os.Stat(argvLog); err == nil {
		argv, _ := os.ReadFile(argvLog)
		t.Errorf("the fixture hook still ran a live scan:\n%s", argv)
	}
	raw, err := os.ReadFile(tunePath)
	if err != nil {
		t.Fatalf("no report written: %v", err)
	}
	tune, err := ParseBlockcheckReports(raw)
	if err != nil || tune == nil {
		t.Fatalf("a captured report did not reach the parser: tune=%v err=%v", tune, err)
	}
	if tune.Args != wantArgs {
		t.Errorf("args = %q, want %q", tune.Args, wantArgs)
	}
}

func TestSelftuneScriptAndParserAgreeOnTheSeparator(t *testing.T) {
	// The round-trip above would also pass if both sides were wrong in the same
	// way only because the script happened to run. This reads the literal.
	src, err := os.ReadFile(repoFile(t, selftuneScript))
	if err != nil {
		t.Fatalf("read script: %v", err)
	}
	want := "SEP='" + reportSeparator + "'"
	if !strings.Contains(string(src), want) {
		t.Errorf("the script does not define %s; the two copies of the separator have drifted apart", want)
	}
	// And the default path, which is the third copy of one decision: the script
	// falls back to it, the ansible role sets it, this package has no default
	// at all and simply does nothing when the env var is empty.
	if !strings.Contains(string(src), "ZAPRET2_TUNE_PATH:-/var/lib/iceslab-node/egress-tune.json") {
		t.Errorf("the script's fallback tune path changed; check the ansible default and the agent env together")
	}
}
