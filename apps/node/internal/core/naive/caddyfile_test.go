package naive

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validInbound() InboundConfig {
	return InboundConfig{
		Hostname: "n1.example.com",
		TLSEmail: "ops@example.com",
	}
}

func TestInboundDefaults(t *testing.T) {
	in := validInbound()
	cfg := in.withDefaults()
	if cfg.ListenPort != 443 {
		t.Errorf("ListenPort default: got %d", cfg.ListenPort)
	}
	if cfg.MasqueradeRoot != "/var/www/html" {
		t.Errorf("MasqueradeRoot default: got %q", cfg.MasqueradeRoot)
	}
}

func TestInboundValidation(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*InboundConfig)
		wantErr string
	}{
		{"missing hostname", func(c *InboundConfig) { c.Hostname = "" }, "Hostname"},
		{"missing TLS email", func(c *InboundConfig) { c.TLSEmail = "" }, "TLSEmail"},
		{"hostname with brace", func(c *InboundConfig) { c.Hostname = "evil{.com" }, "forbidden"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := validInbound()
			tc.mutate(&cfg)
			err := cfg.validate()
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("validate: got %v, want error containing %q", err, tc.wantErr)
			}
		})
	}
}

func TestUserValidation(t *testing.T) {
	cases := []struct {
		name string
		u    User
	}{
		{"empty username", User{Username: "", Password: "p"}},
		{"empty password", User{Username: "u", Password: ""}},
		{"username with space", User{Username: "u ser", Password: "p"}},
		{"password with brace", User{Username: "u", Password: "p}q"}},
		{"password with newline", User{Username: "u", Password: "p\nq"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			u := tc.u
			if err := u.validate(); err == nil {
				t.Errorf("expected validation error for %+v", u)
			}
		})
	}
}

func TestRenderCaddyfileShape(t *testing.T) {
	users := []User{
		{Username: "alice", Password: "secret-a"},
		{Username: "bob", Password: "secret-b"},
	}
	out, err := renderCaddyfile(validInbound(), users, DefaultAdminSocket)
	if err != nil {
		t.Fatalf("renderCaddyfile: %v", err)
	}
	for _, want := range []string{
		"admin unix//run/iceslab/caddy.sock",
		":443, n1.example.com {",
		"tls ops@example.com",
		"forward_proxy {",
		"basic_auth alice secret-a",
		"basic_auth bob secret-b",
		"hide_ip",
		"hide_via",
		"probe_resistance",
		"file_server {",
		"root /var/www/html",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered Caddyfile missing %q. Output:\n%s", want, out)
		}
	}
}

// A-265: Caddy writes handler errors of 500 and up (a forward_proxy dial that
// failed) to http.log.error with the client's remote_ip and the destination
// host. The global block leaves that logger out of the default one, and the
// site writes no access log.
func TestRenderCaddyfileKeepsClientsOutOfTheLog(t *testing.T) {
	out, err := renderCaddyfile(validInbound(), []User{{Username: "alice", Password: "secret-a"}}, DefaultAdminSocket)
	if err != nil {
		t.Fatal(err)
	}
	global := out[:strings.Index(out, "\n}\n")+3]
	if !strings.Contains(global, "\tlog default {\n\t\texclude http.log.error\n\t}\n") {
		t.Errorf("the global block does not leave http.log.error out:\n%s", global)
	}
	site := out[len(global):]
	for _, line := range strings.Split(site, "\n") {
		if strings.TrimSpace(line) == "log" || strings.HasPrefix(strings.TrimSpace(line), "log ") {
			t.Errorf("the site block turns an access log on: %q\n%s", line, out)
		}
	}
}

func TestRenderCaddyfileSortsUsers(t *testing.T) {
	// Same users in different order should produce byte-identical output,
	// otherwise `caddy reload` flaps even on no-op user-set changes.
	users1 := []User{{Username: "bob", Password: "b"}, {Username: "alice", Password: "a"}}
	users2 := []User{{Username: "alice", Password: "a"}, {Username: "bob", Password: "b"}}
	out1, _ := renderCaddyfile(validInbound(), users1, DefaultAdminSocket)
	out2, _ := renderCaddyfile(validInbound(), users2, DefaultAdminSocket)
	if out1 != out2 {
		t.Errorf("expected deterministic order; got:\n--- a:\n%s\n--- b:\n%s", out1, out2)
	}
}

func TestRenderCaddyfileNoUsers(t *testing.T) {
	out, err := renderCaddyfile(validInbound(), nil, DefaultAdminSocket)
	if err != nil {
		t.Fatalf("renderCaddyfile: %v", err)
	}
	// forward_proxy with probe_resistance + zero basic_auth lines fails
	// Caddy validation ("probe resistance requires authentication"), so
	// we skip the whole forward_proxy block when there are no users. The
	// site is pure file_server masquerade, looks like a vanilla
	// static-content host on probes. First AddUser triggers a reload
	// that adds the forward_proxy block. Caught live cycle #8 2026-05-13.
	if strings.Contains(out, "forward_proxy") {
		t.Errorf("expected forward_proxy block to be absent when user list empty:\n%s", out)
	}
	if strings.Contains(out, "probe_resistance") {
		t.Errorf("expected probe_resistance to be absent when user list empty:\n%s", out)
	}
	if !strings.Contains(out, "file_server {") {
		t.Errorf("expected file_server masquerade block:\n%s", out)
	}
}

func TestRenderCaddyfilePropagatesUserError(t *testing.T) {
	bad := []User{{Username: "ok", Password: "ok"}, {Username: "x x", Password: "p"}}
	if _, err := renderCaddyfile(validInbound(), bad, DefaultAdminSocket); err == nil {
		t.Errorf("expected user-validation error to propagate")
	}
}

func TestRenderCaddyfilePropagatesInboundError(t *testing.T) {
	bad := validInbound()
	bad.TLSEmail = ""
	if _, err := renderCaddyfile(bad, nil, DefaultAdminSocket); err == nil {
		t.Errorf("expected inbound-validation error to propagate")
	}
}

// A-118: the admin API never falls back to TCP. A socket path the Caddyfile
// cannot carry is refused, not rendered into a broken global block.
func TestRenderCaddyfileRefusesABadAdminSocket(t *testing.T) {
	for _, sock := range []string{"", "caddy.sock", "/run/x y.sock", "/run/x}\n\tadmin localhost:2019"} {
		if _, err := renderCaddyfile(validInbound(), nil, sock); err == nil {
			t.Errorf("admin socket %q accepted", sock)
		}
	}
}

func TestWriteCaddyfileAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "etc", "caddy", "Caddyfile")
	blob := ":443, n.example.com {\n\ttls e@example.com\n}\n"
	if err := writeCaddyfile(path, blob); err != nil {
		t.Fatalf("writeCaddyfile: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != blob {
		t.Errorf("content mismatch: got %q want %q", string(got), blob)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("expected 0600 perms (file holds plaintext passwords), got %o", mode)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("temp file lingered: %v", err)
	}
}
