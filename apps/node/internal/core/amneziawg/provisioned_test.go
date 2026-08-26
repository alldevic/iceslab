package amneziawg

import (
	"context"
	"io"
	"log/slog"
	"testing"
)

// Provisioned is what /healthz reports to the panel, and Start is what actually
// decides whether the interface comes up. The adapters that have both say in
// their comments that the two share one condition; this one wrote it out twice
// and said so anyway. Asked here of behaviour rather than of the source: an
// unprovisioned adapter must report false AND run no command, a provisioned one
// must report true AND reach awg-quick.

func newProbe(t *testing.T, protocol, privateKey string) (*Adapter, *[]string) {
	t.Helper()
	var calls []string
	inbound := InboundConfig{
		Interface:  "awg0",
		PrivateKey: privateKey,
		ListenPort: 51820,
	}
	if protocol != NameWireguard {
		// The AmneziaWG flavour will not render without its obfuscation
		// parameters; upstream WireGuard has none. Same values the config
		// tests use.
		inbound.Jc, inbound.Jmin, inbound.Jmax = 4, 40, 70
		inbound.S1, inbound.S2, inbound.S3, inbound.S4 = 72, 56, 32, 16
		inbound.H1, inbound.H2, inbound.H3, inbound.H4 = 100, 200, 300, 400
	}
	cfg := Config{
		Protocol:    protocol,
		AwgBin:      "/nonexistent/awg",
		AwgQuickBin: "/nonexistent/awg-quick",
		ConfigPath:  t.TempDir() + "/awg0.conf",
		Inbound:     inbound,
		runCmd: func(_ context.Context, name string, args ...string) ([]byte, error) {
			calls = append(calls, name+" "+joinArgs(args))
			return nil, nil
		},
	}
	return New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil))), &calls
}

func joinArgs(args []string) string {
	out := ""
	for i, a := range args {
		if i > 0 {
			out += " "
		}
		out += a
	}
	return out
}

func TestProvisionedAndStartAgreeOnTheSameCondition(t *testing.T) {
	// One adapter serves both flavours and reports the protocol it was built
	// for as its own name AND its engine, which is what the dispatcher matches
	// on; running both here is also the only place that pair is exercised.
	for _, protocol := range []string{Name, NameWireguard} {
		t.Run(protocol, func(t *testing.T) { runProvisionedCases(t, protocol) })
	}
}

func runProvisionedCases(t *testing.T, protocol string) {
	t.Run("names itself", func(t *testing.T) {
		a, _ := newProbe(t, protocol, "")
		if a.Name() != protocol || a.Engine() != protocol {
			t.Errorf("name/engine = %q/%q, want %q for both: the dispatcher matches on the pair",
				a.Name(), a.Engine(), protocol)
		}
	})

	t.Run("no server key", func(t *testing.T) {
		a, calls := newProbe(t, protocol, "")
		if a.Provisioned() {
			t.Error("an adapter with no server key reported itself provisioned")
		}
		if err := a.Start(context.Background()); err != nil {
			t.Fatalf("Start on an unprovisioned adapter must defer, not fail: %v", err)
		}
		if len(*calls) != 0 {
			t.Errorf("Start deferred according to Provisioned but still ran %v", *calls)
		}
	})

	t.Run("server key present", func(t *testing.T) {
		// The control: without this the case above is also true of an adapter
		// that never starts under any conditions.
		// A real-shaped key: Provisioned only asks whether one is SET, and the
		// renderer downstream is the thing that rejects a malformed one, so a
		// placeholder here would fail Start for a reason this test is not about.
		a, calls := newProbe(t, protocol, "tG5xdCTeSILfQoF+7GiLg2ivVuyVBQA+vwT8cXZTe+k=")
		if !a.Provisioned() {
			t.Error("an adapter WITH a server key reported itself unprovisioned")
		}
		if err := a.Start(context.Background()); err != nil {
			t.Fatalf("Start: %v", err)
		}
		if len(*calls) == 0 {
			t.Error("a provisioned adapter reported true and then ran nothing")
		}
	})
}
