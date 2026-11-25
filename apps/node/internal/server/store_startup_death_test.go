package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core/xray"
)

// A core that passes `xray run -test` and dies the moment it runs for real (a
// taken listen port is the everyday case) must not be acked: the push answers
// with an error for that inbound, and the store, which is what the next agent
// restart restores from, does not take it.
func TestAPushToACoreThatDiesOnSpawnFailsTheInboundAndIsNotStored(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "xray")
	script := "#!/bin/sh\n" +
		"for a in \"$@\"; do [ \"$a\" = \"-test\" ] && exit 0; done\n" +
		"echo 'failed to listen' >&2; exit 23\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake xray: %v", err)
	}
	core := xray.New(xray.Config{
		BinaryPath: bin,
		ConfigPath: filepath.Join(dir, "config.json"),
		RunCmd: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, name, args...).CombinedOutput()
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { _ = core.Stop(context.Background()) })

	store := filepath.Join(dir, "inbounds.json")
	s := serverWithStore(t, store, core)

	const push = `{"inbounds":[{"id":"i1","name":"one","protocol":"xray","port":0,"config":{
		"inboundId": "aaaaaaaa-1111-4000-8000-000000000001",
		"realityDest": "www.cloudflare.com:443",
		"realityServerNames": ["www.cloudflare.com"],
		"realityPrivateKey": "aGVsbG8td29ybGQtdGhpcy1pcy1hLWZha2Uta2V5MDA",
		"realityShortIds": ["0123456789abcdef"]
	}}]}`
	req := httptest.NewRequest(http.MethodPost, "/applyInbounds", strings.NewReader(push))
	rec := httptest.NewRecorder()
	s.handleApplyInbounds(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("a push to a core that died on spawn answered %d (%s), want 500", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "exited within") {
		t.Fatalf("the reason must travel back to the panel, got: %s", rec.Body.String())
	}
	if core.Healthy() {
		t.Fatal("the core reports healthy while its process is dead")
	}

	back, err := readPushStore(store)
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("readPushStore: %v", err)
	}
	if len(back.Inbounds) != 0 {
		t.Fatalf("the store recorded an inbound the core never served: %+v", back.Inbounds)
	}
}
