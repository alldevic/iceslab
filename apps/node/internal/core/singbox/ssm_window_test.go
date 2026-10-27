package singbox

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// П-5: a user change over ssm-api while a restart is under way. The restart
// took its copy of the users before `check` (up to 15 s), the old process
// still ran and took the change over ssm-api, and after the start the
// hand-over synced the OLD copy: a user added in the window was removed, a
// user removed was put back, until the next restart. Here `check` takes a
// second, and the change lands inside it.
func TestAUserChangeDuringARestartSurvivesTheHandOver(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(a *Adapter) error
		who    string
		want   bool
	}{
		{"added in the window", func(a *Adapter) error {
			return a.AddUser(core.User{UserID: "bob", XrayUUID: "22222222-2222-4222-8222-222222222222"})
		}, "bob", true},
		{"removed in the window", func(a *Adapter) error { return a.RemoveUser("alice") }, "alice", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ssm := &fakeSSM{users: map[string]string{}}
			srv := httptest.NewServer(ssm)
			defer srv.Close()
			dir := t.TempDir()
			bin := filepath.Join(dir, "sing-box")
			script := "#!/bin/sh\nif [ \"$1\" = version ]; then echo 'sing-box version 1.13.14'; exit 0; fi\n" +
				"if [ \"$1\" = check ]; then [ -f " + dir + "/slow ] && sleep 1; exit 0; fi\nexec sleep 60\n"
			if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
			a := New(Config{Protocol: "shadowsocks", BinaryPath: bin, ConfigPath: filepath.Join(dir, "ss.json"),
				SSMListen: strings.TrimPrefix(srv.URL, "http://")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err := a.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = a.Stop(context.Background()) })
			if err := a.AddUser(core.User{UserID: "alice", XrayUUID: "11111111-1111-4111-8111-111111111111"}); err != nil {
				t.Fatal(err)
			}
			wire := func(method string) json.RawMessage {
				b, _ := json.Marshal(map[string]string{"method": method, "serverPsk": ssKey()})
				return b
			}
			if err := a.ApplyInbound(9388, wire("2022-blake3-aes-128-gcm")); err != nil {
				t.Fatal(err)
			}
			if !ssm.has("alice") {
				t.Fatal("alice not handed over on the first start")
			}

			// A restart (a changed inbound) whose check takes a second.
			if err := os.WriteFile(filepath.Join(dir, "slow"), nil, 0o600); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- a.ApplyInbound(9389, wire("2022-blake3-aes-128-gcm")) }()
			time.Sleep(300 * time.Millisecond) // inside the check
			if err := tc.change(a); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err != nil {
				t.Fatalf("restart: %v", err)
			}
			// Anything the change scheduled settles within the batch window.
			time.Sleep(3 * time.Second)
			if got := ssm.has(tc.who); got != tc.want {
				t.Fatalf("%s on the managed inbound after the restart: %v, want %v", tc.who, got, tc.want)
			}
		})
	}
}
