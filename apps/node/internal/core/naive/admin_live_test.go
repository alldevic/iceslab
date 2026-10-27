package naive

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A-118, live against caddy-naive (CADDY_NAIVE_BIN): the global block this
// package renders puts the admin API on the unix socket, nothing answers on
// TCP 2019, and reloadArgs reach it and swap the users. The site is a plain
// http one so the test needs no certificate; the global block is the
// rendered one, byte for byte.
func TestTheAdminAPIIsOnTheSocketAndReloadReachesIt(t *testing.T) {
	bin := os.Getenv("CADDY_NAIVE_BIN")
	if bin == "" {
		t.Skip("CADDY_NAIVE_BIN not set: the admin socket is not asked of the real caddy here")
	}
	// Short: a unix socket path has ~108 bytes.
	dir, err := os.MkdirTemp("", "cn")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "run", "caddy.sock")

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()

	cfgPath := filepath.Join(dir, "Caddyfile")
	write := func(users ...string) {
		t.Helper()
		rendered, err := renderCaddyfile(validInbound(), nil, sock)
		if err != nil {
			t.Fatal(err)
		}
		global := rendered[:strings.Index(rendered, "\n}\n")+3]
		global = strings.Replace(global, "/etc/caddy", filepath.Join(dir, "storage"), 1)
		var site strings.Builder
		fmt.Fprintf(&site, "http://127.0.0.1:%d {\n\troute {\n\t\tforward_proxy {\n", port)
		for _, u := range users {
			fmt.Fprintf(&site, "\t\t\tbasic_auth %s pw\n", u)
		}
		fmt.Fprintf(&site, "\t\t}\n\t\trespond \"masquerade\"\n\t}\n}\n")
		if err := writeCaddyfile(cfgPath, global+site.String()); err != nil {
			t.Fatal(err)
		}
	}
	write("alice")

	if err := prepareAdminSocket(sock); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "run", "--config", cfgPath, "--adapter", "caddyfile")
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })

	viaSocket := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		},
	}}
	config := func() string {
		resp, err := viaSocket.Get("http://localhost/config/")
		if err != nil {
			return ""
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}
	var cfg string
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if cfg = config(); cfg != "" {
			break
		}
	}
	if !strings.Contains(cfg, `"listen":"unix/`+sock+`"`) {
		t.Fatalf("the admin API does not answer on the socket as configured: %q", cfg)
	}

	st, err := os.Stat(filepath.Dir(sock))
	if err != nil || st.Mode().Perm() != 0o700 {
		t.Errorf("socket dir: %v %v, want 0700", st, err)
	}
	if st, err := os.Stat(sock); err != nil || st.Mode().Perm()&0o077 != 0 {
		t.Errorf("socket mode %v (%v): group or others may use it", st, err)
	}
	if resp, err := (&http.Client{Timeout: time.Second}).Get("http://127.0.0.1:2019/config/"); err == nil {
		resp.Body.Close()
		t.Errorf("something answers the admin API on TCP 2019: %s", resp.Status)
	}

	write("alice", "bob")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, bin, reloadArgs(cfgPath, sock)...).CombinedOutput(); err != nil {
		t.Fatalf("caddy reload through the socket: %v\n%s", err, out)
	}
	if n := strings.Count(config(), `"auth_credentials":[`); n != 1 {
		t.Fatalf("auth_credentials blocks after reload: %d", n)
	}
	creds := config()
	creds = creds[strings.Index(creds, `"auth_credentials":[`):]
	creds = creds[:strings.Index(creds, "]")]
	if got := strings.Count(creds, ","); got != 1 {
		t.Errorf("reload did not swap the users in, two credentials expected: %s", creds)
	}
}
