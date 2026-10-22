package singbox

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// fakeSSM is an ssm-api that refuses the first `fail` user writes.
type fakeSSM struct {
	mu    sync.Mutex
	fail  int
	users map[string]string
}

func (f *fakeSSM) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, "/server/v1")
	switch {
	case r.Method == http.MethodGet && path == "/users":
		list := []map[string]string{}
		for n := range f.users {
			list = append(list, map[string]string{"username": n})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"users": list})
	case r.Method == http.MethodPut || r.Method == http.MethodPost:
		if f.fail > 0 {
			f.fail--
			http.Error(w, "busy", http.StatusInternalServerError)
			return
		}
		var u ssmUser
		_ = json.NewDecoder(r.Body).Decode(&u)
		name := strings.TrimPrefix(path, "/users/")
		if r.Method == http.MethodPost {
			name = u.UserName
		} else if _, ok := f.users[name]; !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		f.users[name] = u.Password
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusCreated)
		} else {
			w.WriteHeader(http.StatusNoContent)
		}
	case r.Method == http.MethodDelete:
		delete(f.users, strings.TrimPrefix(path, "/users/"))
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *fakeSSM) has(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.users[name]
	return ok
}

// A-213, 22.10: the hand-over after a start failed and the managed inbound
// stayed with nobody. Now it is retried until it takes, and until then the
// core is not healthy.
func TestAFailedHandOverIsRetriedAndTheCoreIsUnhealthyMeanwhile(t *testing.T) {
	ssm := &fakeSSM{fail: 3, users: map[string]string{}}
	srv := httptest.NewServer(ssm)
	defer srv.Close()

	dir := t.TempDir()
	bin := filepath.Join(dir, "sing-box")
	script := "#!/bin/sh\nif [ \"$1\" = version ]; then echo 'sing-box version 1.13.14'; exit 0; fi\n" +
		"if [ \"$1\" = check ]; then exit 0; fi\nexec sleep 60\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	a := New(Config{Protocol: "shadowsocks", BinaryPath: bin, ConfigPath: filepath.Join(dir, "ss.json"),
		SSMListen: strings.TrimPrefix(srv.URL, "http://")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.ssmRetryBase = 30 * time.Millisecond
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	if err := a.AddUser(core.User{UserID: "alice", XrayUUID: "11111111-1111-4111-8111-111111111111"}); err != nil {
		t.Fatal(err)
	}
	wire, _ := json.Marshal(map[string]string{"method": "2022-blake3-aes-128-gcm", "serverPsk": ssKey()})
	err := a.ApplyInbound(9388, wire)
	if err == nil || !strings.Contains(err.Error(), "retrying") {
		t.Fatalf("the push must hear the failed hand-over, got %v", err)
	}
	if a.Healthy() {
		t.Fatal("the core is healthy with its users not handed over")
	}
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline) && !a.Healthy(); time.Sleep(20 * time.Millisecond) {
	}
	if !a.Healthy() {
		t.Fatal("the hand-over was never retried to success")
	}
	if !ssm.has("alice") {
		t.Fatal("healthy, yet alice is not on the managed inbound")
	}
}
