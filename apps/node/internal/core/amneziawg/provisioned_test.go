package amneziawg

import (
	"bytes"
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
)

// Provisioned is what /healthz reports and Start is what decides whether an
// interface comes up; both go through hasPrivateKeyLocked. Asked here of
// behaviour: Provisioned is false exactly when Start defers, for the 1.x
// interface and for the 3.1 one.

func TestProvisionedAgreesWithStartDeferral(t *testing.T) {
	cases := []struct {
		name         string
		key1, key3   string
		wantProvided bool
	}{
		{"neither interface has a key", "", "", false},
		{"1.x only", testWGPrivKey, "", true},
		{"3.1 only", "", testWGPrivKey, true},
		{"both", testWGPrivKey, testWGPrivKey, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			a := New(Config{
				Inbound:     InboundConfig{Interface: "awg0"},
				ConfigPath:  filepath.Join(t.TempDir(), "awg0.conf"),
				AwgQuickBin: "/nonexistent/awg-quick",
				runCmd: func(context.Context, string, ...string) ([]byte, error) {
					return nil, nil
				},
			}, slog.New(slog.NewTextHandler(&logs, nil)))
			a.cfg.Inbound.PrivateKey = tc.key1
			a.v3.cfg.Inbound.PrivateKey = tc.key3

			if got := a.Provisioned(); got != tc.wantProvided {
				t.Errorf("Provisioned() = %v, want %v", got, tc.wantProvided)
			}
			// Each interface on its own: deferred iff it has no key.
			for _, x := range a.both() {
				logs.Reset()
				_ = x.startOne(context.Background())
				deferred := strings.Contains(logs.String(), "deferred")
				x.mu.Lock()
				has := x.hasPrivateKeyLocked()
				x.mu.Unlock()
				if deferred == has {
					t.Errorf("%s: deferred=%v but has key=%v", x.cfg.Inbound.Interface, deferred, has)
				}
			}
		})
	}
}

// Provisioned is Start's own condition (6.1): false exactly when Start defers.
func TestPlainProvisionedAgreesWithStartDeferral(t *testing.T) {
	for _, tc := range []struct {
		name string
		key  string
		want bool
	}{{"no key", "", false}, {"a key", testWGPrivKey, true}} {
		t.Run(tc.name, func(t *testing.T) {
			var logs strings.Builder
			a := New(Config{
				Protocol:    NameWireguard,
				ConfigPath:  filepath.Join(t.TempDir(), "wg0.conf"),
				AwgQuickBin: "/nonexistent/wg-quick",
				runCmd:      func(context.Context, string, ...string) ([]byte, error) { return nil, nil },
			}, slog.New(slog.NewTextHandler(&logs, nil)))
			a.cfg.Inbound.PrivateKey = tc.key
			if got := a.Provisioned(); got != tc.want {
				t.Errorf("Provisioned() = %v, want %v", got, tc.want)
			}
			_ = a.startOne(context.Background())
			if deferred := strings.Contains(logs.String(), "deferred"); deferred == tc.want {
				t.Errorf("deferred=%v with Provisioned=%v", deferred, tc.want)
			}
			// One interface: nothing of a 3.1 one is consulted.
			if len(a.both()) != 1 {
				t.Errorf("a plain instance has %d interfaces", len(a.both()))
			}
		})
	}
}
