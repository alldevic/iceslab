package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// reconcile_mode_values (install-iceslab.sh): a re-run over an existing
// .env.production brings the values derived from the MODE into line with the
// mode now asked for. The function is cut out of the installer with scriptFunc
// and run over a temporary file, with the environment the installer would have.

const bareIPEnv = `POSTGRES_PASSWORD=secret
CORS_ORIGIN=http://203.0.113.7:8080
PUBLIC_URL=http://203.0.113.7:8080
FRONTEND_PORT=8080
FRONTEND_BIND=0.0.0.0
TRUST_PROXY_HOPS=1
ACME_DEFAULT_EMAIL=
`

const domainEnv = `POSTGRES_PASSWORD=secret
CORS_ORIGIN=https://panel.test.org
PUBLIC_URL=https://panel.test.org
FRONTEND_PORT=8080
FRONTEND_BIND=127.0.0.1
TRUST_PROXY_HOPS=3
ACME_DEFAULT_EMAIL=
`

// runReconcile returns the file after the run and what the function printed.
func runReconcile(t *testing.T, file, domain string, env ...string) (string, string) {
	t.Helper()
	bash := needBash(t)
	dir := t.TempDir()
	path := filepath.Join(dir, ".env.production")
	if err := os.WriteFile(path, []byte(file), 0o600); err != nil {
		t.Fatal(err)
	}
	fn := scriptFunc(t, "../../scripts/install-iceslab.sh", "reconcile_mode_values")
	script := `set -euo pipefail
warn() { printf 'WARN %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; exit 1; }
` + fn + `
reconcile_mode_values "$1" "$2" 8080
`
	cmd := exec.Command(bash, "-c", script, "_", path, domain)
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH")}, env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("reconcile_mode_values: %v\n%s", err, out)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(got), string(out)
}

func TestReconcileIPToDomainFixesFourValues(t *testing.T) {
	got, out := runReconcile(t, bareIPEnv, "panel.test.org")
	for _, want := range []string{
		"PUBLIC_URL=https://panel.test.org\n",
		"CORS_ORIGIN=https://panel.test.org\n",
		"FRONTEND_BIND=127.0.0.1\n",
		"TRUST_PROXY_HOPS=3\n",
		"POSTGRES_PASSWORD=secret\n", // nothing else moves
	} {
		if !strings.Contains(got, want) {
			t.Errorf("file lacks %q:\n%s", want, got)
		}
	}
	// A warning for each of the four.
	for _, k := range []string{"PUBLIC_URL:", "CORS_ORIGIN:", "FRONTEND_BIND was", "TRUST_PROXY_HOPS:"} {
		if !strings.Contains(out, "WARN "+k) {
			t.Errorf("no warning for %s:\n%s", k, out)
		}
	}
}

func TestReconcileLeavesAnOperatorsValuesAlone(t *testing.T) {
	custom := strings.NewReplacer(
		"CORS_ORIGIN=http://203.0.113.7:8080", "CORS_ORIGIN=https://admin.corp.example:9443",
		"PUBLIC_URL=http://203.0.113.7:8080", "PUBLIC_URL=http://203.0.113.7:9090",
		"TRUST_PROXY_HOPS=1", "TRUST_PROXY_HOPS=2",
	).Replace(bareIPEnv)
	got, out := runReconcile(t, custom, "panel.test.org")
	for _, want := range []string{
		"CORS_ORIGIN=https://admin.corp.example:9443\n",
		"PUBLIC_URL=http://203.0.113.7:9090\n",
		"TRUST_PROXY_HOPS=2\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("an operator's value was changed (lost %q):\n%s", want, got)
		}
	}
	// FRONTEND_BIND is derived from the mode, not typed by the operator.
	if !strings.Contains(got, "FRONTEND_BIND=127.0.0.1\n") {
		t.Errorf("FRONTEND_BIND not fixed:\n%s", got)
	}
	// What was left is said: both origins, and the 2 with the recommended 3.
	for _, want := range []string{"PUBLIC_URL is http://203.0.113.7:9090", "CORS_ORIGIN is https://admin.corp.example:9443", "TRUST_PROXY_HOPS is 2", "expects 3"} {
		if !strings.Contains(out, want) {
			t.Errorf("the output does not say %q:\n%s", want, out)
		}
	}
}

func TestReconcileExplicitEnvironmentWins(t *testing.T) {
	custom := strings.Replace(bareIPEnv, "PUBLIC_URL=http://203.0.113.7:8080", "PUBLIC_URL=http://203.0.113.7:9090", 1)
	got, _ := runReconcile(t, custom, "panel.test.org",
		"PUBLIC_URL=https://api.test.org", "CORS_ORIGIN=https://a.test.org&b|c",
		"FRONTEND_BIND=0.0.0.0", "TRUST_PROXY_HOPS=4")
	for _, want := range []string{
		"PUBLIC_URL=https://api.test.org\n",
		"CORS_ORIGIN=https://a.test.org&b|c\n", // sed metacharacters arrive as typed
		"FRONTEND_BIND=0.0.0.0\n",
		"TRUST_PROXY_HOPS=4\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("explicit value lost: want %q in\n%s", want, got)
		}
	}
}

func TestReconcileDomainToIPOnlyWarns(t *testing.T) {
	got, out := runReconcile(t, domainEnv, "")
	if got != domainEnv {
		t.Errorf("the file changed going back to bare IP:\n%s", got)
	}
	for _, want := range []string{"WARN FRONTEND_BIND is 127.0.0.1", "WARN PUBLIC_URL is https://panel.test.org"} {
		if !strings.Contains(out, want) {
			t.Errorf("no %q warning:\n%s", want, out)
		}
	}
}

func TestReconcileRerunChangesNothing(t *testing.T) {
	once, _ := runReconcile(t, bareIPEnv, "panel.test.org")
	twice, out := runReconcile(t, once, "panel.test.org")
	if twice != once {
		t.Errorf("a second run changed the file:\n%s\n--- vs ---\n%s", once, twice)
	}
	if out != "" {
		t.Errorf("a second run warned about something:\n%s", out)
	}
	// And a re-run in bare-IP mode over a bare-IP file.
	same, out := runReconcile(t, bareIPEnv, "")
	if same != bareIPEnv || out != "" {
		t.Errorf("bare-IP re-run: changed or warned:\n%s\n%s", same, out)
	}
}

func TestReconcileRejectsABadHopsCount(t *testing.T) {
	bash := needBash(t)
	// runReconcile fails the test on a non-zero exit, so run it by hand.
	dir := t.TempDir()
	path := filepath.Join(dir, "e")
	if err := os.WriteFile(path, []byte(bareIPEnv), 0o600); err != nil {
		t.Fatal(err)
	}
	fn := scriptFunc(t, "../../scripts/install-iceslab.sh", "reconcile_mode_values")
	cmd := exec.Command(bash, "-c", "warn() { :; }\nfail() { echo \"$*\"; exit 1; }\n"+fn+"\nreconcile_mode_values \"$1\" panel.test.org 8080", "_", path)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "TRUST_PROXY_HOPS=9"}
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "0 to 8") {
		t.Errorf("TRUST_PROXY_HOPS=9 was accepted: %v %s", err, out)
	}
	if b, _ := os.ReadFile(path); string(b) != bareIPEnv {
		t.Errorf("the file changed before the bad value was refused:\n%s", b)
	}
}
