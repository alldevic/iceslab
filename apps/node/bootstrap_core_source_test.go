package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// The bootstraps ask the panel for a core's file before GitHub
// (lib/node-env.sh, core_panel_get). Two layers here, both with `curl` a
// stand-in on PATH that records what it was asked and answers from a script:
//
//   - the library function, for every answer the panel can give;
//   - the REAL bootstrap-<core>.sh, run up to its sha256 check (the copy has
//     only its root test and install path swapped), for the three promises the
//     operator sees: the panel's file is judged by the pin, the panel's "not
//     carried" reaches the operator with the core and the arch in it, and
//     with the source set to github the panel is not asked at all.
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash.

const (
	testPanel = "https://panel.test"
	testToken = "hb_0123456789abcdef_SECRET"
)

// panelPayload is a payload as the panel issues it; `note` is there for its
// base64url alphabet: "??>>" encodes to "_" and "-" characters.
func panelPayload(t *testing.T, url, token string) string {
	t.Helper()
	raw := map[string]string{
		"nodeCertPem": "c", "nodeKeyPem": "k", "caCertPem": "a", "note": "??>>??>>",
		"nodeId": "n1",
	}
	if url != "" {
		raw["panelUrl"] = url
	}
	if token != "" {
		raw["heartbeatToken"] = token
	}
	blob, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	// The panel's encoding: Buffer.toString("base64url"), no padding.
	return base64.RawURLEncoding.EncodeToString(blob)
}

// curlStub answers like the panel and GitHub would. PANEL_CODES is a list the
// panel answers one by one (the last repeats); PANEL_BODY and PANEL_SHA are
// what a 200 carries; PANEL_UNREACHABLE makes curl fail as with no route.
const curlStub = `#!/usr/bin/env bash
echo "curl $*" >>"$CALLS"
args=("$@"); out=""; hdr=""
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in -o) out="${args[i+1]}" ;; -D) hdr="${args[i+1]}" ;; -K) cat >>"$STDIN_LOG" ;; esac
done
url="${args[${#args[@]}-1]}"
case "$url" in
  https://panel.test/*|http://panel.test/*)
    if [[ -n "${PANEL_UNREACHABLE:-}" ]]; then
      printf '000'; echo "curl: (7) Failed to connect to panel.test port 443" >&2; exit 7
    fi
    codes=($PANEL_CODES); n=$(cat "$STATE" 2>/dev/null || echo 0)
    idx=$n; ((idx >= ${#codes[@]})) && idx=$((${#codes[@]} - 1))
    echo $((n + 1)) >"$STATE"
    code="${codes[idx]:-200}"
    if [[ "$code" == 200 ]]; then printf '%s' "${PANEL_BODY-WRONG}" >"$out"; else printf '%s' "${PANEL_ERR:-}" >"$out"; fi
    { printf 'HTTP/1.1 %s\r\n' "$code"; [[ -z "${PANEL_SHA:-}" ]] || printf 'x-iceslab-sha256: %s\r\n' "$PANEL_SHA"; [[ -z "${PANEL_RETRY_AFTER:-}" ]] || printf 'Retry-After: %s\r\n' "$PANEL_RETRY_AFTER"; } >"$hdr"
    printf '%s' "$code" ;;
  *) printf '%s' "${GITHUB_BODY-FROM-GITHUB}" >"$out" ;;
esac
`

type coreSrc struct {
	dir, calls, stdin string
}

func newCoreSrc(t *testing.T, payloadB64 string) (coreSrc, []string) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "curl"), []byte(curlStub), 0o755); err != nil {
		t.Fatal(err)
	}
	envFile := filepath.Join(dir, "env")
	if err := os.WriteFile(envFile, []byte("OTHER=1\nNODE_PAYLOAD="+payloadB64+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := coreSrc{dir: dir, calls: filepath.Join(dir, "calls"), stdin: filepath.Join(dir, "stdin")}
	env := []string{
		"PATH=" + bin + ":/usr/bin:/bin", "HOME=" + dir,
		"CALLS=" + s.calls, "STDIN_LOG=" + s.stdin, "STATE=" + filepath.Join(dir, "state"),
		"ICESLAB_NODE_ENV=" + envFile, "ICESLAB_CORE_RETRY_PAUSE=0",
		"PANEL_CODES=200",
	}
	return s, env
}

func (s coreSrc) called(t *testing.T) string {
	t.Helper()
	b, _ := os.ReadFile(s.calls)
	return string(b)
}

func runShell(t *testing.T, env []string, prog string) (string, error) {
	t.Helper()
	cmd := exec.Command(needBash(t), "-c", prog)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func shaOf(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// libCall sources the real library and runs one core_panel_artifact for
// mtg 2.2.8 / amd64 into $DEST, then prints the file.
func libCall(t *testing.T, env []string, dest string) (string, error) {
	t.Helper()
	prog := "set -euo pipefail\n. scripts/lib/node-env.sh\n" +
		"if core_panel_artifact mtg 2.2.8 amd64 '" + dest + "' " + shaOf("GOOD") + "; then echo \"RESULT=panel:$(cat '" + dest + "')\"; else echo RESULT=github; fi\n"
	return runShell(t, env, prog)
}

func TestTheLibraryAsksThePanelWithThePayloadsAddressAndToken(t *testing.T) {
	s, env := newCoreSrc(t, panelPayload(t, testPanel+"/", testToken))
	dest := filepath.Join(s.dir, "mtg.tgz")
	env = append(env, "PANEL_BODY=GOOD", "PANEL_SHA="+shaOf("GOOD"))
	out, err := libCall(t, env, dest)
	if err != nil || !strings.Contains(out, "RESULT=panel:GOOD") {
		t.Fatalf("the panel's file was not taken: %v\n%s", err, out)
	}
	calls := s.called(t)
	if strings.Count(calls, "curl ") != 1 || !strings.Contains(calls, testPanel+"/api/internal/cores/mtg/2.2.8/amd64") {
		t.Errorf("curl calls:\n%s", calls)
	}
	// https only, no redirects, and the token not on the command line.
	for _, want := range []string{"--proto =http,https", "--max-redirs 0"} {
		if !strings.Contains(calls, want) {
			t.Errorf("curl was not called with %q:\n%s", want, calls)
		}
	}
	if strings.Contains(calls, testToken) {
		t.Errorf("the token is on a curl command line:\n%s", calls)
	}
	if blob, _ := os.ReadFile(s.stdin); !strings.Contains(string(blob), "Authorization: Bearer "+testToken) {
		t.Errorf("the token did not reach curl's config on stdin: %q", blob)
	}
	if strings.Contains(out, testToken) {
		t.Errorf("the token is in the output:\n%s", out)
	}
}

func TestTheLibraryPassesTheScriptRouteAndWaitsOutAThrottle(t *testing.T) {
	s, env := newCoreSrc(t, panelPayload(t, testPanel, testToken))
	dest := filepath.Join(s.dir, "install-release.sh")
	env = append(env, "PANEL_CODES=429 429 200", "PANEL_BODY=GOOD", "PANEL_SHA="+shaOf("GOOD"), "PANEL_RETRY_AFTER=0")
	out, err := runShell(t, env, "set -euo pipefail\n. scripts/lib/node-env.sh\ncore_panel_script xray-install e741a4f56d368afbb9e5be3361b40c4552d3710d '"+dest+"' "+shaOf("GOOD")+" && echo GOT=$(cat '"+dest+"')\n")
	if err != nil || !strings.Contains(out, "GOT=GOOD") {
		t.Fatalf("%v\n%s", err, out)
	}
	calls := s.called(t)
	if strings.Count(calls, "curl ") != 3 || !strings.Contains(calls, testPanel+"/api/internal/cores/scripts/xray-install/e741a4f56d368afbb9e5be3361b40c4552d3710d") {
		t.Errorf("want three asks of the script route (429, 429, 200):\n%s", calls)
	}
	if !strings.Contains(out, "too many requests, waiting") {
		t.Errorf("the throttle was not said:\n%s", out)
	}
}

// Every way the panel can fail to serve, in the default source (GitHub next,
// with the reason) and in panel-only (the bootstrap ends with the reason).
func TestEveryAnswerThePanelCannotServeIsSaidAndHandledBySource(t *testing.T) {
	notCarried := `{"error":"NOT_CARRIED","message":"this panel carries no mtg 2.2.8 for amd64. Rebuild the panel image with CORE_ARCHES including amd64, or install that node on an architecture the panel carries."}`
	cases := []struct {
		name  string
		env   []string
		pay   string
		wants []string
	}{
		{"404: the image does not carry the arch", []string{"PANEL_CODES=404", "PANEL_ERR=" + notCarried},
			"ok", []string{"mtg 2.2.8 (amd64)", "this panel carries no mtg 2.2.8 for amd64", "CORE_ARCHES"}},
		{"404: a panel older than the channel", []string{"PANEL_CODES=404", `PANEL_ERR={"error":"Not Found"}`},
			"ok", []string{"mtg 2.2.8 (amd64)", "no such file"}},
		{"401", []string{"PANEL_CODES=401"}, "ok", []string{"refused this node's token"}},
		{"410", []string{"PANEL_CODES=410"}, "ok", []string{"this node was deleted"}},
		{"500", []string{"PANEL_CODES=500"}, "ok", []string{"HTTP 500"}},
		{"throttled to the end", []string{"PANEL_CODES=429"}, "ok", []string{"kept answering too many requests"}},
		{"unreachable", []string{"PANEL_UNREACHABLE=1"}, "ok", []string{"not reachable", "Failed to connect"}},
		{"the panel carries another file", []string{"PANEL_SHA=" + shaOf("OTHER")}, "ok", []string{"carries another file than the pinned one", shaOf("OTHER"), shaOf("GOOD")}},
		{"payload without an address", nil, "noaddr", []string{"names no panel address or token"}},
		{"payload without a token", nil, "notoken", []string{"names no panel address or token"}},
		{"an http panel", nil, "http", []string{"is not https"}},
	}
	for _, c := range cases {
		for _, source := range []string{"panel", "panel-only"} {
			t.Run(c.name+"/"+source, func(t *testing.T) {
				pay := panelPayload(t, testPanel, testToken)
				switch c.pay {
				case "noaddr":
					pay = panelPayload(t, "", testToken)
				case "notoken":
					pay = panelPayload(t, testPanel, "")
				case "http":
					pay = panelPayload(t, "http://panel.test", testToken)
				}
				s, env := newCoreSrc(t, pay)
				env = append(append(env, c.env...), "ICESLAB_CORE_SOURCE="+source)
				out, err := libCall(t, env, filepath.Join(s.dir, "f"))
				for _, w := range c.wants {
					if !strings.Contains(out, w) {
						t.Errorf("output lacks %q:\n%s", w, out)
					}
				}
				if strings.Contains(out, testToken) {
					t.Errorf("the token is in the output:\n%s", out)
				}
				if source == "panel" {
					if err != nil || !strings.Contains(out, "RESULT=github") || !strings.Contains(out, "trying GitHub") {
						t.Errorf("want a warning and GitHub next: %v\n%s", err, out)
					}
				} else if err == nil || strings.Contains(out, "RESULT=") || !strings.Contains(out, "GitHub is not tried") {
					t.Errorf("panel-only must stop with the reason: %v\n%s", err, out)
				}
				if _, statErr := os.Stat(filepath.Join(s.dir, "f")); statErr == nil && source == "panel" {
					t.Errorf("a file of a refused answer was left for the sha check to find")
				}
			})
		}
	}
}

func TestWithTheSourceGithubThePanelIsNotAsked(t *testing.T) {
	s, env := newCoreSrc(t, panelPayload(t, testPanel, testToken))
	env = append(env, "ICESLAB_CORE_SOURCE=github")
	out, err := libCall(t, env, filepath.Join(s.dir, "f"))
	if err != nil || !strings.Contains(out, "RESULT=github") {
		t.Fatalf("%v\n%s", err, out)
	}
	if c := s.called(t); c != "" {
		t.Errorf("curl was called:\n%s", c)
	}
}

func TestAnHttpPanelIsAskedOnlyWhenAllowed(t *testing.T) {
	s, env := newCoreSrc(t, panelPayload(t, "http://panel.test", testToken))
	env = append(env, "PANEL_BODY=GOOD", "PANEL_SHA="+shaOf("GOOD"), "ICESLAB_CORE_ALLOW_HTTP=1")
	out, err := libCall(t, env, filepath.Join(s.dir, "f"))
	if err != nil || !strings.Contains(out, "RESULT=panel:GOOD") || !strings.Contains(s.called(t), "http://panel.test/api/internal/cores/mtg/2.2.8/amd64") {
		t.Fatalf("%v\n%s\n%s", err, out, s.called(t))
	}
}

func TestAnUnknownSourceIsRefused(t *testing.T) {
	_, env := newCoreSrc(t, panelPayload(t, testPanel, testToken))
	env = append(env, "ICESLAB_CORE_SOURCE=mirror")
	out, err := runShell(t, env, ". scripts/lib/node-env.sh\n")
	if err == nil || !strings.Contains(out, "use panel, panel-only or github") {
		t.Errorf("%v\n%s", err, out)
	}
}

// ───── the real bootstraps ─────

type coreScript struct {
	script, component, arch string
	// the file name the pin gives for amd64, to tell the GitHub URL by
	github string
}

var coreScripts = []coreScript{
	{"bootstrap-xray.sh", "xray", "amd64", "github.com/XTLS/Xray-core/releases/download/"},
	{"bootstrap-singbox.sh", "singbox", "amd64", "github.com/"},
	{"bootstrap-hysteria.sh", "hysteria", "amd64", "github.com/apernet/hysteria/releases/download/"},
	{"bootstrap-mtg.sh", "mtg", "amd64", "github.com/9seconds/mtg/releases/download/"},
	{"bootstrap-mieru.sh", "mita", "amd64", "github.com/enfein/mieru/releases/download/"},
}

// stageBootstrap copies the script and its lib into the test's dir with the
// two things a non-root test needs swapped: the root test, and the path the
// binary would be installed to (so a machine that has the core is no matter).
func stageBootstrap(t *testing.T, s coreSrc, name string) string {
	t.Helper()
	root := filepath.Join(s.dir, "scripts")
	if err := os.MkdirAll(filepath.Join(root, "lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	lib, _ := os.ReadFile(filepath.Join("scripts", "lib", "node-env.sh"))
	if err := os.WriteFile(filepath.Join(root, "lib", "node-env.sh"), lib, 0o644); err != nil {
		t.Fatal(err)
	}
	body := readScript(t, name)
	body = regexp.MustCompile(`(?m)^(\s*)\[\[ \$EUID -eq 0 \]\] \|\| fail .*$`).ReplaceAllString(body, "${1}true")
	body = regexp.MustCompile(`(?m)^INSTALL_PATH=/usr/local/bin/`).ReplaceAllString(body, "INSTALL_PATH="+s.dir+"/installed-")
	body = regexp.MustCompile(`(?m)^INSTALL_DIR=/usr/local/bin`).ReplaceAllString(body, "INSTALL_DIR="+s.dir)
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func runBootstrap(t *testing.T, c coreScript, extraEnv ...string) (out, calls string, err error) {
	t.Helper()
	if runtime.GOARCH != "amd64" {
		t.Skip("these runs pin the amd64 file names")
	}
	s, env := newCoreSrc(t, panelPayload(t, testPanel, testToken))
	// dpkg-query: no mita yet; the others are not on PATH either.
	if err := os.WriteFile(filepath.Join(s.dir, "bin", "dpkg-query"), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := stageBootstrap(t, s, c.script)
	env = append(env, "SINGBOX_DEST="+s.dir+"/installed-sing-box")
	env = append(env, extraEnv...)
	cmd := exec.Command(needBash(t), path)
	cmd.Env = env
	blob, err := cmd.CombinedOutput()
	return string(blob), s.called(t), err
}

func TestAPanelFileThatIsNotThePinnedOneIsNotInstalled(t *testing.T) {
	want := regexp.MustCompile(`checksum mismatch for \S+: got ` + shaOf("WRONG") + `, expected [0-9a-f]{64}`)
	for _, c := range coreScripts {
		t.Run(c.component, func(t *testing.T) {
			// The panel says nothing in the header: the bootstrap's own check is
			// the decision, and it does not turn to GitHub for a second opinion.
			out, calls, err := runBootstrap(t, c)
			if err == nil || !want.MatchString(out) {
				t.Fatalf("want the checksum refusal with both values: %v\n%s", err, out)
			}
			if !strings.Contains(calls, testPanel+"/api/internal/cores/"+c.component+"/") {
				t.Errorf("the panel was not asked first:\n%s", calls)
			}
			if strings.Contains(calls, "github.com") || strings.Contains(out, "trying GitHub") {
				t.Errorf("a mismatch is final, GitHub must not be tried:\n%s\n%s", calls, out)
			}
			if strings.Contains(out+calls, testToken) {
				t.Errorf("the token leaked:\n%s\n%s", out, calls)
			}
		})
	}
}

func TestAPanelThatDoesNotCarryTheArchReachesTheOperatorByName(t *testing.T) {
	msg := func(c coreScript) string {
		return `{"error":"NOT_CARRIED","message":"this panel carries no ` + c.component + ` for amd64. Rebuild the panel image with CORE_ARCHES including amd64."}`
	}
	for _, c := range coreScripts {
		t.Run(c.component, func(t *testing.T) {
			out, calls, err := runBootstrap(t, c, "PANEL_CODES=404", "PANEL_ERR="+msg(c), "ICESLAB_CORE_SOURCE=panel-only")
			if err == nil || !strings.Contains(out, c.component+" ") || !strings.Contains(out, "(amd64)") ||
				!strings.Contains(out, "this panel carries no "+c.component+" for amd64") {
				t.Fatalf("the operator is not told which core and arch: %v\n%s", err, out)
			}
			if strings.Contains(calls, "github.com") {
				t.Errorf("panel-only went to GitHub:\n%s", calls)
			}
			// The default source goes on to GitHub, and says it does.
			out, calls, _ = runBootstrap(t, c, "PANEL_CODES=404", "PANEL_ERR="+msg(c))
			if !strings.Contains(out, "trying GitHub") || !strings.Contains(calls, "github.com") {
				t.Errorf("the default source did not fall back to GitHub:\n%s\n%s", out, calls)
			}
		})
	}
}

func TestWithTheSourceGithubNoBootstrapAsksThePanel(t *testing.T) {
	for _, c := range coreScripts {
		t.Run(c.component, func(t *testing.T) {
			out, calls, err := runBootstrap(t, c, "ICESLAB_CORE_SOURCE=github", "GITHUB_BODY=WRONG")
			if strings.Contains(calls, "panel.test") {
				t.Errorf("the panel was asked:\n%s", calls)
			}
			if !strings.Contains(calls, "github.com") || err == nil || !strings.Contains(out, "checksum mismatch") {
				t.Errorf("want the base behaviour (GitHub, then the sha refusal): %v\n%s\n%s", err, out, calls)
			}
		})
	}
}

// xray's second download: install-release.sh from the panel, then from
// raw.githubusercontent.com, in the order the install runs them.
func TestXrayAsksThePanelForInstallReleaseToo(t *testing.T) {
	s := readScript(t, "bootstrap-xray.sh")
	panel := strings.Index(s, `core_panel_script xray-install "$XRAY_INSTALLER_REF" "$TMP/install-release.sh" "$XRAY_INSTALLER_SHA"`)
	raw := strings.Index(s, `curl --proto '=https' --max-redirs 0 -fsSL "$INSTALLER_URL"`)
	check := strings.Index(s, `[[ "$GOT_SHA" == "$XRAY_INSTALLER_SHA" ]]`)
	if panel == -1 || raw == -1 || check == -1 || !(panel < raw && raw < check) {
		t.Errorf("install-release.sh must be asked of the panel, then GitHub, then checked: %d %d %d", panel, raw, check)
	}
}

// Whatever the source, the bootstrap's own check decides: the panel call comes
// before the sha256 comparison in every script, and no script compares the
// panel's header instead of the file.
func TestEveryBootstrapChecksTheFileAfterTheSource(t *testing.T) {
	for _, c := range coreScripts {
		s := readScript(t, c.script)
		call := strings.Index(s, "core_panel_artifact "+c.component+" ")
		sum := strings.Index(s, "GOT_SHA=$(sha256sum")
		if call == -1 || sum == -1 || call > sum {
			t.Errorf("%s: core_panel_artifact %s at %d, sha256sum at %d", c.script, c.component, call, sum)
		}
	}
}
