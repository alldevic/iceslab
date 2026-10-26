package naive

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
)

// A-280: naive has no certificate but Caddy's ACME one, so a provisioned site
// needs 80/tcp and nothing else does; there is no self-signed path to tell
// apart, unlike hysteria.
func TestUsesACMEOnceASiteIsRenderedAndNotAfterIdle(t *testing.T) {
	a := New(Config{CaddyfilePath: filepath.Join(t.TempDir(), "Caddyfile")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if a.UsesACME() {
		t.Fatal("ACME before any inbound named a hostname")
	}
	if err := a.ApplyInbound(443, json.RawMessage(`{"hostname":"naive.example.net","tlsEmail":"ops@iceslab.test"}`)); err != nil {
		t.Fatal(err)
	}
	if !a.UsesACME() {
		t.Fatal("a rendered site takes its certificate over ACME, and does not say so")
	}
	if err := a.Idle(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a.UsesACME() {
		t.Fatal("an idle naive needs no 80/tcp")
	}
}
