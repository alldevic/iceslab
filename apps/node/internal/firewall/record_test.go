package firewall

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeUfw puts a ufw that succeeds and logs its arguments on the PATH.
func fakeUfw(t *testing.T, ok bool) {
	t.Helper()
	dir := t.TempDir()
	rc := "0"
	if !ok {
		rc = "1"
	}
	script := "#!/bin/sh\nexit " + rc + "\n"
	if err := os.WriteFile(filepath.Join(dir, "ufw"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func withRecord(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "firewall-rules")
	SetRecordPath(path)
	allowedMu.Lock()
	allowedSpecs = map[string]struct{}{}
	allowedMu.Unlock()
	t.Cleanup(func() { SetRecordPath("") })
	return path
}

func recorded(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return ""
		}
		t.Fatal(err)
	}
	return string(b)
}

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

// The agent writes down the port rules it opens (one "port/proto" per line,
// sorted), so --uninstall can take them out; Close removes the line.
func TestAllowRecordsTheRuleAndCloseForgetsIt(t *testing.T) {
	fakeUfw(t, true)
	path := withRecord(t)
	ctx := context.Background()

	Allow(ctx, quiet, 8443, "tcp")
	Allow(ctx, quiet, 24084, "udp")
	Allow(ctx, quiet, 8443, "tcp") // cached: no second line
	if got, want := recorded(t, path), "24084/udp\n8443/tcp\n"; got != want {
		t.Fatalf("record = %q, want %q", got, want)
	}
	Close(ctx, quiet, 8443, "tcp")
	if got, want := recorded(t, path), "24084/udp\n"; got != want {
		t.Fatalf("record after Close = %q, want %q", got, want)
	}
}

// A rule ufw refused is not open, so it is not written down.
func TestAllowDoesNotRecordARuleUfwRefused(t *testing.T) {
	fakeUfw(t, false)
	path := withRecord(t)
	Allow(context.Background(), quiet, 8443, "tcp")
	if got := recorded(t, path); got != "" {
		t.Fatalf("record = %q, want nothing", got)
	}
}

// Rules restricted to a source (the cascade's link ports) are tracked by the
// chain's own file and are not the record's business.
func TestSourceRulesAreNotInTheRecord(t *testing.T) {
	fakeUfw(t, true)
	path := withRecord(t)
	AllowSource(context.Background(), quiet, 24100, "tcp", "203.0.113.5")
	if got := recorded(t, path); strings.TrimSpace(got) != "" {
		t.Fatalf("record = %q, want nothing", got)
	}
}

func TestNoRecordPathKeepsNothing(t *testing.T) {
	fakeUfw(t, true)
	SetRecordPath("")
	allowedMu.Lock()
	allowedSpecs = map[string]struct{}{}
	allowedMu.Unlock()
	Allow(context.Background(), quiet, 8443, "tcp") // must not panic or write
}
