package mtprotoproxy

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func baseInbound() InboundConfig {
	return InboundConfig{Domain: "www.cloudflare.com", ListenPort: 2083, MetricsPort: 3130}
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
		{Name: "bbb", Secret: secretB},
		{Name: "aaa", Secret: secretA},
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
	if got["METRICS_PORT"].(float64) != 3130 {
		t.Errorf("METRICS_PORT = %v", got["METRICS_PORT"])
	}
	if got["METRICS_EXPORT_LINKS"] != false {
		t.Error("METRICS_EXPORT_LINKS must be False: those links carry every user's secret")
	}
	// Loopback only, spelled out rather than left to upstream's default.
	wl := got["METRICS_WHITELIST"].([]any)
	found := false
	for _, e := range wl {
		s, ok := e.(string)
		if !ok {
			t.Fatalf("METRICS_WHITELIST holds a non-string: %v", wl)
		}
		if s == "127.0.0.1" {
			found = true
		}
		// IPv6 can never be the source: the socket is IPv4-only above.
		if strings.Contains(s, ":") {
			t.Errorf("METRICS_WHITELIST has an IPv6 entry %q; the socket is IPv4-only", s)
		}
	}
	if !found {
		t.Errorf("METRICS_WHITELIST = %v, loopback itself is missing", wl)
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
		{Name: "zzz", Secret: secretA},
		{Name: "aaa", Secret: secretB},
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
	if !strings.Contains(s, "METRICS_PORT = 3130") {
		t.Error("MetricsPort should default to 3130 (mtg keeps 3129): without it there is no per-user accounting, which is the point of this engine")
	}
}
