package hysteria

import (
	"context"
	"testing"
)

// A-280: the server opens 80/tcp for a core whose config takes an ACME
// certificate. hysteria does exactly when the applied inbound has no panel
// pair: the acme branch of renderConfig.
func TestUsesACMEOnlyForTheACMEBranch(t *testing.T) {
	a, _ := selfSignedAdapter(t)
	if a.UsesACME() {
		t.Fatal("ACME before any inbound")
	}

	if err := a.ApplyInbound(443, pushed(t, map[string]any{"hostname": "hy.example.net"})); err != nil {
		t.Fatal(err)
	}
	if !a.UsesACME() {
		t.Fatal("a domain with no panel pair renders acme, and does not say so")
	}

	certPEM, keyPEM, _ := pemPair(t)
	if err := a.ApplyInbound(443, pushed(t, map[string]any{"tlsCertPem": certPEM, "tlsKeyPem": keyPEM})); err != nil {
		t.Fatal(err)
	}
	if a.UsesACME() {
		t.Fatal("the panel's self-signed pair (E30a) needs no 80/tcp")
	}

	// Idle forgets the inbound where systemd runs hysteria (the unit stops);
	// in spawn mode Idle leaves hysteria running, and its ACME with it.
	a.cfg.ServiceUnit, a.cfg.BinaryPath = "hysteria-server.service", "/usr/local/bin/hysteria"
	if err := a.ApplyInbound(443, pushed(t, map[string]any{"hostname": "hy.example.net"})); err != nil {
		t.Fatal(err)
	}
	if err := a.Idle(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a.UsesACME() {
		t.Fatal("an idled core needs no 80/tcp")
	}
}
