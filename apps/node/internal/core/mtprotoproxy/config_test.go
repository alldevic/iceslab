package mtprotoproxy

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func baseInbound() InboundConfig {
	return InboundConfig{Domain: "www.cloudflare.com", ListenPort: 2083, MetricsPort: 3129}
}

const secretA = "0123456789abcdef0123456789abcdef"
const secretB = "fedcba9876543210fedcba9876543210"

// ─────────────────────────────────────────────────────────────────────────────
// The load-bearing test: ask PYTHON whether the file we generate is the file we
// think we generate.
//
// Every other test here checks the string we build. None of them can answer the
// only question that matters on a node — will mtprotoproxy read this and get the
// users we meant. The config is EXECUTED (runpy.run_path), so a syntax error is
// a proxy that does not start, and a subtly wrong literal is a user who silently
// does not exist. Both are invisible from Go.
//
// Skipped when there is no python3, so a machine without one still runs the
// suite. Confirmed the check can fail before trusting it: feeding it a file with
// an unterminated string exits non-zero.
// ─────────────────────────────────────────────────────────────────────────────

func runPy(t *testing.T, blob []byte) map[string]any {
	t.Helper()
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not present; skipping the executed-config check")
	}
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.py")
	if err := os.WriteFile(cfgPath, blob, 0o600); err != nil {
		t.Fatal(err)
	}
	// runpy.run_path is exactly how mtprotoproxy loads it (mtprotoproxy.py:108).
	script := `
import json, runpy, sys
d = runpy.run_path(sys.argv[1])
out = {k: v for k, v in d.items() if not k.startswith("_")}
print(json.dumps(out, default=str))
`
	cmd := exec.Command(py, "-c", script, cfgPath)
	stdout, err := cmd.Output()
	if err != nil {
		t.Fatalf("python refused the generated config: %v\n--- config ---\n%s", err, blob)
	}
	var got map[string]any
	if err := json.Unmarshal(stdout, &got); err != nil {
		t.Fatalf("parse python output: %v (%s)", err, stdout)
	}
	return got
}

func TestPythonReadsWhatWeMeant(t *testing.T) {
	users := []User{
		{Name: "bbb", Secret: secretB, QuotaBytes: 1 << 30, MaxConns: 5},
		{Name: "aaa", Secret: secretA, ExpiresAt: time.Date(2026, 10, 4, 15, 35, 0, 0, time.UTC)},
	}
	blob, err := renderConfig(baseInbound(), users)
	if err != nil {
		t.Fatal(err)
	}
	got := runPy(t, blob)

	if got["PORT"].(float64) != 2083 {
		t.Errorf("PORT = %v, want 2083", got["PORT"])
	}
	gotUsers := got["USERS"].(map[string]any)
	if len(gotUsers) != 2 || gotUsers["aaa"] != secretA || gotUsers["bbb"] != secretB {
		t.Errorf("USERS = %v", gotUsers)
	}
	modes := got["MODES"].(map[string]any)
	if modes["tls"] != true || modes["classic"] != false || modes["secure"] != false {
		t.Errorf("MODES = %v, want tls only", modes)
	}
	if got["TLS_DOMAIN"] != "www.cloudflare.com" {
		t.Errorf("TLS_DOMAIN = %v", got["TLS_DOMAIN"])
	}
	// Rounded UP by a day: the panel owns the precise cut, and a backstop that
	// fires early takes the channel from someone who paid for it.
	exp := got["USER_EXPIRATIONS"].(map[string]any)
	if exp["aaa"] != "05/10/2026" {
		t.Errorf("USER_EXPIRATIONS[aaa] = %v, want 05/10/2026 (the day AFTER expiry)", exp["aaa"])
	}
	if _, ok := exp["bbb"]; ok {
		t.Errorf("a user with no expiry must not appear in USER_EXPIRATIONS")
	}
	quota := got["USER_DATA_QUOTA"].(map[string]any)
	if quota["bbb"].(float64) != float64(1<<30) {
		t.Errorf("USER_DATA_QUOTA[bbb] = %v", quota["bbb"])
	}
	conns := got["USER_MAX_TCP_CONNS"].(map[string]any)
	if conns["bbb"].(float64) != 5 {
		t.Errorf("USER_MAX_TCP_CONNS[bbb] = %v", conns["bbb"])
	}
	if got["METRICS_PORT"].(float64) != 3129 {
		t.Errorf("METRICS_PORT = %v", got["METRICS_PORT"])
	}
	if got["METRICS_EXPORT_LINKS"] != false {
		t.Error("METRICS_EXPORT_LINKS must be False: those links carry every user's secret")
	}
	wl := got["METRICS_WHITELIST"].([]any)
	if len(wl) != 1 || wl[0] != "127.0.0.1" {
		t.Errorf("METRICS_WHITELIST = %v, want loopback only", wl)
	}
}

func TestEmptyUserSetStillLoads(t *testing.T) {
	// An inbound with nobody assigned must listen and refuse everyone, not fail
	// to start — otherwise the first user added to a fresh inbound races the
	// process coming up.
	blob, err := renderConfig(baseInbound(), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := runPy(t, blob)
	if len(got["USERS"].(map[string]any)) != 0 {
		t.Errorf("USERS = %v, want empty", got["USERS"])
	}
	for _, k := range []string{"USER_EXPIRATIONS", "USER_DATA_QUOTA", "USER_MAX_TCP_CONNS"} {
		if _, ok := got[k]; ok {
			t.Errorf("%s emitted for an empty user set; mtprotoproxy setdefaults it anyway", k)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Injection. The config is executed as root's Python, so this is the security
// boundary of the package, not input hygiene.
// ─────────────────────────────────────────────────────────────────────────────

func TestRefusesInjection(t *testing.T) {
	cases := []struct {
		what string
		mk   func() ([]byte, error)
	}{
		{"quote+code in user name", func() ([]byte, error) {
			return renderConfig(baseInbound(), []User{{Name: `a", "x": __import__("os").system("id"), "b`, Secret: secretA}})
		}},
		{"newline in user name", func() ([]byte, error) {
			return renderConfig(baseInbound(), []User{{Name: "a\nimport os", Secret: secretA}})
		}},
		{"non-hex secret", func() ([]byte, error) {
			return renderConfig(baseInbound(), []User{{Name: "a", Secret: `"; import os; x="` + strings.Repeat("a", 13)}})
		}},
		{"short secret", func() ([]byte, error) {
			return renderConfig(baseInbound(), []User{{Name: "a", Secret: "abcdef"}})
		}},
		{"quote in domain", func() ([]byte, error) {
			c := baseInbound()
			c.Domain = `x.com"; import os; y="`
			return renderConfig(c, []User{{Name: "a", Secret: secretA}})
		}},
		{"newline in domain", func() ([]byte, error) {
			c := baseInbound()
			c.Domain = "x.com\nimport os"
			return renderConfig(c, []User{{Name: "a", Secret: secretA}})
		}},
		{"port out of range", func() ([]byte, error) {
			c := baseInbound()
			c.ListenPort = 999999
			return renderConfig(c, []User{{Name: "a", Secret: secretA}})
		}},
		{"negative quota", func() ([]byte, error) {
			return renderConfig(baseInbound(), []User{{Name: "a", Secret: secretA, QuotaBytes: -1}})
		}},
	}
	for _, tc := range cases {
		t.Run(tc.what, func(t *testing.T) {
			if _, err := tc.mk(); err == nil {
				t.Fatal("accepted a value that reaches executed Python")
			}
		})
	}
}

func TestRefusesDuplicateNames(t *testing.T) {
	// Two entries with one name collapse into a single dict key, and which
	// secret survives depends on push order — a user whose link works or does
	// not depending on iteration.
	_, err := renderConfig(baseInbound(), []User{
		{Name: "a", Secret: secretA},
		{Name: "a", Secret: secretB},
	})
	if err == nil {
		t.Fatal("accepted a duplicate user name")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Determinism. The adapter skips the reload when the rendered bytes match, so
// unstable output means a SIGUSR2 on every push — and Go map order is random.
// ─────────────────────────────────────────────────────────────────────────────

func TestRenderIsStableAcrossOrder(t *testing.T) {
	a := []User{
		{Name: "zzz", Secret: secretA, MaxConns: 3},
		{Name: "aaa", Secret: secretB, QuotaBytes: 42},
		{Name: "mmm", Secret: secretA},
	}
	b := []User{a[1], a[2], a[0]}
	x, err := renderConfig(baseInbound(), a)
	if err != nil {
		t.Fatal(err)
	}
	y, err := renderConfig(baseInbound(), b)
	if err != nil {
		t.Fatal(err)
	}
	if string(x) != string(y) {
		t.Errorf("render depends on input order:\n--- a ---\n%s\n--- b ---\n%s", x, y)
	}
}

func TestDefaultsFillIn(t *testing.T) {
	blob, err := renderConfig(InboundConfig{Domain: "a.example"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	if !strings.Contains(s, "PORT = 443") {
		t.Error("ListenPort should default to 443")
	}
	if !strings.Contains(s, "METRICS_PORT = 3129") {
		t.Error("MetricsPort should default to 3129: without it there is no per-user accounting, which is the point of this engine")
	}
}
