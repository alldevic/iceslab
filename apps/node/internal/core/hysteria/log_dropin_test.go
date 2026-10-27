package hysteria

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// A-265: the unit systemd runs gets HYSTERIA_LOG_LEVEL=error from a runtime
// drop-in when its environment lacks it, once; a unit that has it (a new
// installer's, or the drop-in already in place) is left alone, with no reload
// and no restart.
type unitFake struct {
	mu    sync.Mutex
	env   string // what `systemctl show -p Environment --value` answers
	calls []string
}

func (f *unitFake) run(_ context.Context, name string, args ...string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	return nil
}

func (f *unitFake) output(_ context.Context, name string, args ...string) ([]byte, error) {
	if name != "systemctl" || len(args) < 1 || args[0] != "show" {
		return nil, errors.New("unexpected command")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return []byte(f.env + "\n"), nil
}

func unitAdapter(t *testing.T, f *unitFake, unit string) (*Adapter, string) {
	t.Helper()
	dir := t.TempDir()
	return New(Config{
		ServiceUnit:    unit,
		RunCmd:         f.run,
		CmdOutput:      f.output,
		RuntimeUnitDir: dir,
	}, slog.New(slog.NewTextHandler(io.Discard, nil))), dir
}

func TestALegacyUnitGetsTheLogLevelOnceAndIsRestartedIfRunning(t *testing.T) {
	f := &unitFake{env: "PATH=/usr/bin"}
	a, dir := unitAdapter(t, f, "hysteria")
	a.ensureUnitLogLevel(context.Background())

	body, err := os.ReadFile(filepath.Join(dir, "hysteria.service.d", "iceslab-log.conf"))
	if err != nil {
		t.Fatalf("drop-in not written (the unit name needs its .service suffix): %v", err)
	}
	if !strings.Contains(string(body), "[Service]\nEnvironment=HYSTERIA_LOG_LEVEL=error\n") {
		t.Fatalf("drop-in body:\n%s", body)
	}
	if strings.Join(f.calls, ";") != "systemctl daemon-reload;systemctl try-restart hysteria.service" {
		t.Fatalf("calls %v, want daemon-reload then try-restart (a stopped unit stays stopped)", f.calls)
	}

	// systemd now carries it: the next start reads it and does nothing.
	f.env = "PATH=/usr/bin HYSTERIA_LOG_LEVEL=error"
	f.calls = nil
	a.ensureUnitLogLevel(context.Background())
	if len(f.calls) != 0 {
		t.Fatalf("a unit that carries the level was touched again: %v", f.calls)
	}
}

func TestANewInstallersUnitIsLeftAlone(t *testing.T) {
	f := &unitFake{env: "HYSTERIA_LOG_LEVEL=error"}
	a, dir := unitAdapter(t, f, "hysteria.service")
	a.ensureUnitLogLevel(context.Background())
	if len(f.calls) != 0 {
		t.Fatalf("calls %v on a unit that already logs at error", f.calls)
	}
	if _, err := os.Stat(filepath.Join(dir, "hysteria.service.d")); !os.IsNotExist(err) {
		t.Fatalf("a drop-in was written for a unit that needs none: %v", err)
	}
}

func TestAnotherLevelInTheUnitIsOverridden(t *testing.T) {
	// info: a unit someone set by hand. warn: what bootstrap-hysteria.sh wrote
	// until 26.10, which still names the client on every broken connection.
	for _, level := range []string{"info", "warn"} {
		f := &unitFake{env: "HYSTERIA_LOG_LEVEL=" + level}
		a, _ := unitAdapter(t, f, "hysteria.service")
		a.ensureUnitLogLevel(context.Background())
		if len(f.calls) != 2 {
			t.Fatalf("%s: calls %v, want the drop-in applied (it comes after the unit's line, the later wins)", level, f.calls)
		}
		// After the reload systemd answers the later assignment: one restart.
		f.env, f.calls = "HYSTERIA_LOG_LEVEL=error", nil
		a.ensureUnitLogLevel(context.Background())
		if len(f.calls) != 0 {
			t.Fatalf("%s: restarted again on the next start: %v", level, f.calls)
		}
	}
}

func TestTheDropInIsWrittenAtStartInUnitMode(t *testing.T) {
	f := &unitFake{env: ""}
	a, dir := unitAdapter(t, f, "hysteria")
	a.cfg.BinaryPath = "/usr/local/bin/hysteria"
	a.cfg.AuthCallbackPort = freeTCP(t)
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	if _, err := os.Stat(filepath.Join(dir, "hysteria.service.d", "iceslab-log.conf")); err != nil {
		t.Fatalf("Start in unit mode wrote no drop-in: %v", err)
	}
}
