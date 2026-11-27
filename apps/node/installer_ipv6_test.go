package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// writeNodeEnv runs the installer's env-file block (the payload/port lines and
// the NODE_HOST one) with the given NODE_HOST assignment, and returns the file.
func writeNodeEnv(t *testing.T, nodeHost string) string {
	t.Helper()
	blob, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	start := strings.Index(s, "  install -m 0600 /dev/null \"$ENV_FILE\"\n")
	endMark := "    echo \"NODE_HOST=${NODE_HOST}\" >> \"$ENV_FILE\"\n  fi\n"
	end := strings.Index(s, endMark)
	if start == -1 || end == -1 || end < start {
		t.Fatal("the installer's env block is not where this test looks")
	}
	env := filepath.Join(t.TempDir(), "env")
	prog := "set -euo pipefail\nENV_FILE='" + env + "'\nPAYLOAD=cGF5\nNODE_PORT=1337\n" +
		nodeHost + "\n" + s[start:end+len(endMark)]
	if b, err := exec.Command(needBash(t), "-c", prog).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, b)
	}
	got, err := os.ReadFile(env)
	if err != nil {
		t.Fatal(err)
	}
	return string(got)
}

// No NODE_HOST in the environment: the file does not name one, and the agent
// decides (`::` where it can). A given one is written as it is.
func TestInstallerLeavesNodeHostToTheAgent(t *testing.T) {
	blob, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(blob), "\nNODE_HOST=${NODE_HOST:-}\n") {
		t.Error("the installer's NODE_HOST default is not empty")
	}
	if got := writeNodeEnv(t, "NODE_HOST=''"); strings.Contains(got, "NODE_HOST") {
		t.Errorf("an empty NODE_HOST was written:\n%s", got)
	}
	for _, v := range []string{"0.0.0.0", "10.1.2.3", "::"} {
		if got := writeNodeEnv(t, "NODE_HOST='"+v+"'"); !strings.Contains(got, "\nNODE_HOST="+v+"\n") {
			t.Errorf("NODE_HOST=%s not kept:\n%s", v, got)
		}
	}
}

// --panel-ip takes an IPv6 address, a prefix and a mixed list; ufw gets one
// rule each.
func TestPanelIPTakesIPv6(t *testing.T) {
	calls, _ := runFirewall(t, "PANEL_IP='2001:db8::5, 198.51.100.7,2001:db8:1::/48'", "")
	want := []string{
		"allow from 2001:db8::5 to any port 1337 proto tcp",
		"allow from 198.51.100.7 to any port 1337 proto tcp",
		"allow from 2001:db8:1::/48 to any port 1337 proto tcp",
	}
	got := strings.Join(calls, "\n")
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Errorf("missing ufw call %q in\n%s", w, got)
		}
	}
	if strings.Contains(got, "allow 1337/tcp") {
		t.Errorf("the world-open rule was added beside --panel-ip:\n%s", got)
	}
}

// With IPV6=no in /etc/default/ufw the installer warns; with IPV6=yes or no
// line (ufw's own default is yes) it stays quiet.
func TestFirewallWarnsOnUfwIPv6No(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []struct {
		content string
		warns   bool
	}{
		{"IPV6=no\nDEFAULT_FORWARD_POLICY=\"DROP\"\n", true},
		{"IPV6=yes\nDEFAULT_FORWARD_POLICY=\"DROP\"\n", false},
		{"DEFAULT_FORWARD_POLICY=\"DROP\"\n", false},
	} {
		f := filepath.Join(dir, "ufw-"+strings.ReplaceAll(strings.Fields(c.content)[0], "=", "-"))
		if err := os.WriteFile(f, []byte(c.content), 0o644); err != nil {
			t.Fatal(err)
		}
		_, out := runFirewall(t, "UFW_DEFAULT_FILE='"+f+"'", "")
		if got := strings.Contains(out, "IPV6=no"); got != c.warns {
			t.Errorf("%q: warned=%v, want %v\n%s", c.content, got, c.warns, out)
		}
	}
}
