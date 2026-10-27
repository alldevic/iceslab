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

// chainFw records the link-port rules: "+" opened, "-" closed, "*" for open to
// anyone. Names resolve through `dns`, which a test changes between pushes.
type chainFw struct {
	mu  sync.Mutex
	ops []string
	dns map[string]string
}

func recordChainFirewall(t *testing.T) *chainFw {
	t.Helper()
	r := &chainFw{dns: map[string]string{}}
	oldAllow, oldClose, oldResolve, oldSrc, oldCloseSrc := fwAllow, fwClose, fwResolve, fwAllowSource, fwCloseSource
	add := func(op string) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.ops = append(r.ops, op)
	}
	fwAllow = func(_ context.Context, _ *slog.Logger, port int, proto string) {
		add(fmt.Sprintf("+%d/%s<-*", port, proto))
	}
	fwClose = func(_ context.Context, _ *slog.Logger, port int, proto string) {
		add(fmt.Sprintf("-%d/%s<-*", port, proto))
	}
	fwAllowSource = func(_ context.Context, _ *slog.Logger, port int, proto, src string) {
		add(fmt.Sprintf("+%d/%s<-%s", port, proto, src))
	}
	fwCloseSource = func(_ context.Context, _ *slog.Logger, port int, proto, src string) {
		add(fmt.Sprintf("-%d/%s<-%s", port, proto, src))
	}
	fwResolve = func(_ context.Context, _ *slog.Logger, names []string) (ok, bad []string) {
		r.mu.Lock()
		defer r.mu.Unlock()
		for _, n := range names {
			switch {
			case !strings.Contains(n, ".example"):
				ok = append(ok, n)
			case r.dns[n] != "":
				ok = append(ok, r.dns[n])
			default:
				bad = append(bad, n)
			}
		}
		return ok, bad
	}
	t.Cleanup(func() {
		fwAllow, fwClose, fwResolve, fwAllowSource, fwCloseSource = oldAllow, oldClose, oldResolve, oldSrc, oldCloseSrc
	})
	return r
}

func (r *chainFw) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.ops
	r.ops = nil
	sort.Strings(out)
	return out
}

func (r *chainFw) resolves(name, ip string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.dns[name] = ip
}

func chainPush(ingress string) string {
	return `{"inbounds":[],"chain":{"engine":"singbox","config":{},"socks":[],"socksPassword":"p","linkIngress":[` + ingress + `]}}`
}

func chainServer(t *testing.T) (*Server, string) {
	t.Helper()
	store := filepath.Join(t.TempDir(), "inbounds.json")
	s := serverWithStore(t, store)
	s.cfg.Chain = chain.New(chain.Config{
		ConfigPath: filepath.Join(t.TempDir(), "chain", "config.json"),
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Lifetime:   context.Background(),
	})
	return s, store
}

func joinOps(ops []string) string { return strings.Join(ops, " ") }

// A-111: the ports the chain receives legs on are opened from the chain block
// itself, restricted to the previous hops, on the push and again at start from
// the stored push. Before, only the legacy xray fragment opened a leg's port,
// and a node with a chain gets none.
func TestTheChainsLinkPortsAreOpenedOnThePushAndAtStart(t *testing.T) {
	fw := recordChainFirewall(t)
	s, store := chainServer(t)
	push := chainPush(`{"port":24001,"transports":["udp"],"allowFrom":["10.0.0.1"]},` +
		`{"port":24002,"transports":["tcp","udp"],"allowFrom":["10.0.0.2"]}`)
	pushOver(t, s, push)
	want := "+24001/udp<-10.0.0.1 +24002/tcp<-10.0.0.2 +24002/udp<-10.0.0.2"
	if got := joinOps(fw.take()); got != want {
		t.Fatalf("on the push %q, want %q", got, want)
	}
	// At start, from what the push left on disk (a ufw reset, a reinstall).
	if err := os.WriteFile(store, []byte(push), 0o600); err != nil {
		t.Fatal(err)
	}
	s.ensureFirewallFromStore(context.Background())
	if got := joinOps(fw.take()); got != want {
		t.Fatalf("at start %q, want %q", got, want)
	}
}

// A hop that moved: the new address is opened, the old one closed. The
// cascade taken off the node closes everything that was opened for it.
func TestAMovedHopIsClosedAndARemovedCascadeClosesAll(t *testing.T) {
	fw := recordChainFirewall(t)
	s, _ := chainServer(t)
	pushOver(t, s, chainPush(`{"port":24000,"transports":["tcp"],"allowFrom":["10.0.0.1"]}`))
	fw.take()

	pushOver(t, s, chainPush(`{"port":24000,"transports":["tcp"],"allowFrom":["10.0.0.9"]}`))
	if got, want := joinOps(fw.take()), "+24000/tcp<-10.0.0.9 -24000/tcp<-10.0.0.1"; got != want {
		t.Fatalf("hop moved: %q, want %q", got, want)
	}

	pushOver(t, s, `{"inbounds":[]}`)
	if got, want := joinOps(fw.take()), "-24000/tcp<-10.0.0.9"; got != want {
		t.Fatalf("cascade off: %q, want %q", got, want)
	}
}

// A refused push keeps the block in force, so it closes nothing. Called the
// way the push calls it with the accepted block.
func TestARefusedPushClosesNothing(t *testing.T) {
	fw := recordChainFirewall(t)
	s, _ := chainServer(t)
	accepted := &dto.NodeChain{LinkIngress: []dto.ChainLinkIngress{{Port: 24000, Transports: []string{"tcp"}, AllowFrom: []string{"10.0.0.1"}}}}
	s.ensureChainFirewall(context.Background(), accepted)
	fw.take()
	// The refused block is never handed here; the accepted one is again.
	s.ensureChainFirewall(context.Background(), accepted)
	for _, op := range fw.take() {
		if strings.HasPrefix(op, "-") {
			t.Fatalf("closed %q on a push that changed nothing in force", op)
		}
	}
}

// A hop whose name does not resolve: the port falls open to anyone. The next
// push, once it resolves, opens it for the hop and closes the wide rule: the
// width does not stick, although port, transport and name are the same.
func TestAWideRuleIsReplacedOnceTheHopResolves(t *testing.T) {
	fw := recordChainFirewall(t)
	s, _ := chainServer(t)
	push := chainPush(`{"port":24001,"transports":["udp"],"allowFrom":["prev.example"]}`)
	pushOver(t, s, push)
	if got, want := joinOps(fw.take()), "+24001/udp<-*"; got != want {
		t.Fatalf("unresolved: %q, want %q", got, want)
	}
	fw.resolves("prev.example", "10.0.0.5")
	pushOver(t, s, push)
	if got, want := joinOps(fw.take()), "+24001/udp<-10.0.0.5 -24001/udp<-*"; got != want {
		t.Fatalf("resolved: %q, want %q", got, want)
	}
}

// A port with no source named is not opened: AllowFrom would fall open to
// anywhere.
func TestALinkPortWithNoSourceIsNotOpened(t *testing.T) {
	fw := recordChainFirewall(t)
	s := newServerWith(t)
	s.ensureChainFirewall(context.Background(), &dto.NodeChain{
		LinkIngress: []dto.ChainLinkIngress{{Port: 24000, Transports: []string{"tcp"}}},
	})
	if got := fw.take(); len(got) != 0 {
		t.Fatalf("opened %v", got)
	}
}
