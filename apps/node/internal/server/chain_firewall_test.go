package server

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/chain"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

type fromRecorder struct {
	mu     sync.Mutex
	opened []string
}

func recordAllowFrom(t *testing.T) *fromRecorder {
	t.Helper()
	r := &fromRecorder{}
	old := fwAllowFrom
	fwAllowFrom = func(_ context.Context, _ *slog.Logger, port int, proto string, from []string) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.opened = append(r.opened, fmt.Sprintf("%d/%s<-%s", port, proto, strings.Join(from, ",")))
	}
	t.Cleanup(func() { fwAllowFrom = old })
	return r
}

func (r *fromRecorder) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.opened
	r.opened = nil
	sort.Strings(out)
	return out
}

// A push with a chain block whose legs come in on hy2 (udp) and shadowsocks
// (tcp+udp), with no legacy fragments on any inbound.
const chainPushWithIngress = `{"inbounds":[],"chain":{"engine":"singbox","config":{},"socks":[],"socksPassword":"p",` +
	`"linkIngress":[{"port":24001,"transports":["udp"],"allowFrom":["10.0.0.1"]},` +
	`{"port":24002,"transports":["tcp","udp"],"allowFrom":["10.0.0.2","prev.example"]}]}}`

// A-111: the ports the chain receives legs on are opened from the chain block
// itself, restricted to the previous hops, on the push and again at start
// from the stored push. Before, only the legacy xray fragment opened a leg's
// port, and a node with a chain gets none.
func TestTheChainsLinkPortsAreOpenedOnThePushAndAtStart(t *testing.T) {
	fw := recordAllowFrom(t)
	recordFirewall(t)
	store := filepath.Join(t.TempDir(), "inbounds.json")
	s := serverWithStore(t, store)
	s.cfg.Chain = chain.New(chain.Config{
		ConfigPath: filepath.Join(t.TempDir(), "chain", "config.json"),
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Lifetime:   context.Background(),
	})
	pushOver(t, s, chainPushWithIngress)
	want := "24001/udp<-10.0.0.1 24002/tcp<-10.0.0.2,prev.example 24002/udp<-10.0.0.2,prev.example"
	if got := strings.Join(fw.take(), " "); got != want {
		t.Fatalf("on the push opened %q, want %q", got, want)
	}

	// At start, from what the push left on disk (a ufw reset, a reinstall).
	if err := os.WriteFile(store, []byte(chainPushWithIngress), 0o600); err != nil {
		t.Fatal(err)
	}
	s.ensureFirewallFromStore(context.Background())
	if got := strings.Join(fw.take(), " "); got != want {
		t.Fatalf("at start opened %q, want %q", got, want)
	}
}

// A port with no source named is not opened: AllowFrom would fall open to
// anywhere.
func TestALinkPortWithNoSourceIsNotOpened(t *testing.T) {
	fw := recordAllowFrom(t)
	s := newServerWith(t)
	s.ensureChainFirewall(context.Background(), &dto.NodeChain{
		LinkIngress: []dto.ChainLinkIngress{{Port: 24000, Transports: []string{"tcp"}}},
	})
	if got := fw.take(); len(got) != 0 {
		t.Fatalf("opened %v", got)
	}
}
