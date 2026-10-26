package mieru

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A-275, live against mita (MIERU_BIN, the pinned 3.37.0): a mieru inbound
// with no users is taken without an error and opens no port; the first user
// brings the proxy up, RUNNING and listening. mita runs here as an ordinary
// user: its socket and stored config are moved into a temp dir by its own
// variables (MITA_UDS_PATH, MITA_CONFIG_FILE, pkg/appctl/server.go:210, :775)
// and MITA_INSECURE_UDS skips the chown to a `mita` account (pkg/cli/server.go:412).
func TestLiveAnInboundWithNoUsersWaitsAndTheFirstUserStartsMita(t *testing.T) {
	bin := os.Getenv("MIERU_BIN")
	if bin == "" {
		t.Skip("MIERU_BIN not set: the empty user list is not asked of the real mita here")
	}
	// Short: a unix socket path has ~108 bytes.
	dir, err := os.MkdirTemp("", "mi")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	env := append(os.Environ(),
		"MITA_UDS_PATH="+filepath.Join(dir, "mita.sock"),
		"MITA_CONFIG_FILE="+filepath.Join(dir, "server.conf.pb"),
		"MITA_INSECURE_UDS=1",
		"MITA_LOG_NO_TIMESTAMP=1",
	)
	daemon := exec.Command(bin, "run")
	daemon.Env = env
	daemon.Stdout, daemon.Stderr = io.Discard, io.Discard
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = daemon.Process.Kill(); _, _ = daemon.Process.Wait() })
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if _, err := os.Stat(filepath.Join(dir, "mita.sock")); err == nil {
			break
		}
	}

	run := func(ctx context.Context, name string, args ...string) ([]byte, error) {
		c := exec.CommandContext(ctx, name, args...)
		c.Env = env
		return c.CombinedOutput()
	}
	status := func() string {
		out, _ := run(context.Background(), bin, "status")
		return strings.TrimSpace(string(out))
	}

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	listening := func() bool {
		c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
		if err != nil {
			return false
		}
		c.Close()
		return true
	}

	a := New(Config{
		BinaryPath: bin,
		ConfigPath: filepath.Join(dir, "server.json"),
		Inbound:    InboundConfig{ListenPort: port, MTU: 1400, LoggingLevel: "INFO"},
		RunCmd:     run,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if err := a.ApplyIdentifiedInbound("in-1", port, []byte(`{"mtu":1400}`)); err != nil {
		t.Fatalf("an inbound with no users refused the push: %v", err)
	}
	if a.Waiting() != core.NoUsersReason {
		t.Fatalf("not waiting with no users: %q", a.Waiting())
	}
	if strings.Contains(status(), "RUNNING") || listening() {
		t.Fatalf("mita serves with no user: %s, listening %v", status(), listening())
	}

	if err := a.AddUser(core.User{UserID: "u-1", Username: "alice", XrayUUID: "6f1c2c1e-2a7b-4c51-9d1e-8a1f4b3c2d10"}); err != nil {
		t.Fatalf("the first user: %v", err)
	}
	up := false
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		if up = strings.Contains(status(), "RUNNING") && listening(); up {
			break
		}
	}
	if !up {
		t.Fatalf("the first user did not bring mita up: %s, listening %v", status(), listening())
	}

	// And the last one leaving takes it down, port closed.
	if err := a.RemoveUser("u-1"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(status(), "RUNNING") || listening() {
		t.Fatalf("mita serves on with no user: %s, listening %v", status(), listening())
	}
}
