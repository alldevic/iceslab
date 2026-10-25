package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A-267: the host Caddyfile masks subscription and bootstrap tokens in Caddy's
// logs. The installer writes it once, so deploy.sh renders it again on every
// update (refresh_host_caddyfile in scripts/ops/_lib.sh), or an operator who
// updated would keep a Caddy writing tokens into access.log.
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash.

const (
	panelInstaller = "../../scripts/install-iceslab.sh"
	opsLib         = "../../scripts/ops/_lib.sh"
)

// caddyfileFunc: write_caddyfile() as written, heredoc and all. The heredoc
// closes its own site blocks with `}` at column 0, so the function ends at
// the `}` after `EOF`, not at the first one.
func caddyfileFunc(t *testing.T, path string) string {
	t.Helper()
	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := strings.ReplaceAll(string(blob), "\r\n", "\n")
	start := strings.Index(s, "\nwrite_caddyfile() {\n")
	if start == -1 {
		t.Fatalf("%s has no write_caddyfile()", path)
	}
	end := strings.Index(s[start:], "\nEOF\n}\n")
	if end == -1 {
		t.Fatalf("%s: write_caddyfile() has no end", path)
	}
	return s[start : start+end+len("\nEOF\n}\n")]
}

// The installer runs curl-piped and cannot source _lib.sh, so the function is
// in both. A fix made in one copy and not the other would give a fresh install
// one file and the next deploy another.
func TestTheHostCaddyfileIsWrittenByOneFunction(t *testing.T) {
	if a, b := caddyfileFunc(t, panelInstaller), caddyfileFunc(t, opsLib); a != b {
		t.Errorf("write_caddyfile differs between install-iceslab.sh and scripts/ops/_lib.sh:\n--- installer\n%s\n--- _lib.sh\n%s", a, b)
	}
}

const legacyCaddyfile = `panel.example.com {
  log {
    output file /var/log/caddy/access.log
    format json
  }
  reverse_proxy 127.0.0.1:8080
}

# Anti-probing: bare-IP / unknown hostname requests on :443 get a silent 204
# so scanners can't fingerprint Iceslab.
:443 {
  tls internal
  respond 204
}
`

type caddyRefresh struct {
	out, calls, file string
	backups           []string
	stamp             string
}

// runRefresh: the file in place (empty: none), whether a stamp of it lies
// beside it, the env file's lines, and whether `caddy validate` passes.
func runRefresh(t *testing.T, existing string, stamped bool, env string, validates bool) caddyRefresh {
	t.Helper()
	bash := needBash(t)
	dir := t.TempDir()
	file := filepath.Join(dir, "Caddyfile")
	stamp := filepath.Join(dir, ".iceslab-caddyfile.sha256")
	envFile := filepath.Join(dir, ".env.production")
	calls := filepath.Join(dir, "calls")
	if existing != "" {
		if err := os.WriteFile(file, []byte(existing), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(envFile, []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}
	note := `echo "$(basename "$0") $*" >>'` + calls + "'\n"
	validate := "exit 0\n"
	if !validates {
		validate = "exit 1\n"
	}
	bin := stubs(t, map[string]string{
		"caddy":     note + validate,
		"systemctl": note + "exit 0\n",
	})
	prog := "set -euo pipefail\nLIB_PREFIX=test\nsource '" + opsLib + "'\n"
	if stamped {
		prog += "sha256sum '" + file + "' | cut -d' ' -f1 >'" + stamp + "'\n"
	}
	prog += "CADDYFILE_PATH='" + file + "' ENV_FILE='" + envFile + "' refresh_host_caddyfile\necho DONE\n"
	cmd := exec.Command(bash, "-c", prog)
	cmd.Env = []string{"PATH=" + bin + ":/usr/bin:/bin"}
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "DONE") {
		t.Fatalf("refresh_host_caddyfile: %v\n%s", err, out)
	}
	r := caddyRefresh{out: string(out)}
	if b, err := os.ReadFile(calls); err == nil {
		r.calls = string(b)
	}
	if b, err := os.ReadFile(file); err == nil {
		r.file = string(b)
	}
	if b, err := os.ReadFile(stamp); err == nil {
		r.stamp = strings.TrimSpace(string(b))
	}
	r.backups, _ = filepath.Glob(file + ".bak.*")
	return r
}

func assertRewritten(t *testing.T, what string, r caddyRefresh, prefix string) {
	t.Helper()
	for _, want := range []string{
		"panel.example.com {",
		"reverse_proxy 127.0.0.1:8080",
		"log iceslab_secret_paths",
		"@secret_paths path " + prefix + "/* /api/internal/bootstrap/* /api/users/by-subscription-token/* /api/settings/subscription/preview/*",
		"include http.log.error",
	} {
		if !strings.Contains(r.file, want) {
			t.Errorf("%s: the new file has no %q:\n%s", what, want, r.file)
		}
	}
	if !strings.Contains(r.calls, "caddy validate") || !strings.Contains(r.calls, "systemctl reload caddy") {
		t.Errorf("%s: not validated and reloaded:\n%s", what, r.calls)
	}
	if len(r.backups) != 1 {
		t.Errorf("%s: want one backup of the old file, got %v", what, r.backups)
	}
	if r.stamp == "" {
		t.Errorf("%s: no stamp of the new file, the next deploy would call it edited", what)
	}
}

func TestADeployRewritesTheHostCaddyfileTheInstallerWrote(t *testing.T) {
	// A panel installed with v0.2.1: no stamp, the file exactly as written then.
	r := runRefresh(t, legacyCaddyfile, false, "", true)
	assertRewritten(t, "v0.2.1 file", r, "/sub")

	// Installed later: the stamp says the file is still ours, whatever it holds.
	r = runRefresh(t, "panel.example.com {\n  reverse_proxy 127.0.0.1:8080\n}\n", true, "SUBSCRIPTION_PATH_PREFIX=/s3cr3t\n", true)
	assertRewritten(t, "stamped file", r, "/s3cr3t")

	// And the deploy after it finds nothing to do: no rewrite, no reload.
	again := runRefresh(t, r.file, true, "SUBSCRIPTION_PATH_PREFIX=/s3cr3t\n", true)
	if !strings.Contains(again.out, "already current") || strings.Contains(again.calls, "systemctl") {
		t.Errorf("a current file was rewritten or reloaded:\n%s\ncalls:\n%s", again.out, again.calls)
	}
}

func TestADeployLeavesAnEditedHostCaddyfileAlone(t *testing.T) {
	edited := strings.Replace(legacyCaddyfile, "  reverse_proxy", "  encode gzip\n  reverse_proxy", 1)
	r := runRefresh(t, edited, false, "", true)
	if r.file != edited {
		t.Errorf("an edited file was rewritten:\n%s", r.file)
	}
	if !strings.Contains(r.out, "edited by hand") || strings.Contains(r.calls, "systemctl") {
		t.Errorf("want a warning and no reload, got:\n%s\ncalls:\n%s", r.out, r.calls)
	}
}

func TestADeployKeepsTheOldHostCaddyfileWhenTheNewOneDoesNotValidate(t *testing.T) {
	r := runRefresh(t, legacyCaddyfile, false, "", false)
	if r.file != legacyCaddyfile || len(r.backups) != 0 || strings.Contains(r.calls, "systemctl") {
		t.Errorf("a file that does not validate was put in place:\n%s\ncalls:\n%s", r.file, r.calls)
	}
}

func TestADeployWithoutAHostCaddyDoesNothing(t *testing.T) {
	r := runRefresh(t, "", false, "", true)
	if !strings.Contains(r.out, "nothing to refresh") || r.calls != "" {
		t.Errorf("a bare-IP install was touched:\n%s\ncalls:\n%s", r.out, r.calls)
	}
}
