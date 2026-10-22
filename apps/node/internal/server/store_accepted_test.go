package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

/*
A-113, 22.10: the store was written before the push was applied. A push the
cores refused left them serving the previous config, and the next agent restart
(the normal update path) came up on the refused one, with nothing to fall back
to. The store is now what the cores took.
*/

// pickyServerCore refuses any inbound whose config says "bad", and remembers
// the configs it was given.
type pickyServerCore struct {
	fakeCore
	got []string
}

func (p *pickyServerCore) ApplyInbound(_ int, cfg json.RawMessage) error {
	p.got = append(p.got, string(cfg))
	if strings.Contains(string(cfg), "bad") {
		return errRefusedForTest
	}
	return nil
}

var errRefusedForTest = errors.New("core rejected the config")

func pushOver(t *testing.T, s *Server, body string) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/applyInbounds", strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleApplyInbounds(rec, req)
	return rec.Code
}

// port:0 keeps ensureInboundFirewall from shelling out to ufw.
const (
	goodPush = `{"inbounds":[
		{"id":"i1","name":"one","protocol":"xray","port":0,"config":{"v":"good-1"}}
	]}`
	refusedPush = `{"inbounds":[
		{"id":"i1","name":"one","protocol":"xray","port":0,"config":{"v":"bad-1"}},
		{"id":"i2","name":"two","protocol":"xray","port":0,"config":{"v":"bad-2"}},
		{"id":"i3","name":"three","protocol":"xray","port":0,"config":{"v":"good-3"}}
	]}`
)

func TestARestartComesUpOnWhatTheCoresTookNotOnWhatTheyRefused(t *testing.T) {
	store := filepath.Join(t.TempDir(), "inbounds.json")
	live := &pickyServerCore{fakeCore: fakeCore{name: "xray", engine: "xray", running: true}}
	s := serverWithStore(t, store, live)

	if code := pushOver(t, s, goodPush); code != http.StatusOK {
		t.Fatalf("good push answered %d", code)
	}
	if code := pushOver(t, s, refusedPush); code != http.StatusInternalServerError {
		t.Fatalf("a push with refused inbounds answered %d, want 500", code)
	}

	// The agent restarts: a new process, the same store.
	fresh := &pickyServerCore{fakeCore: fakeCore{name: "xray", engine: "xray", running: true}}
	restarted := serverWithStore(t, store, fresh)
	restarted.restoreFromStore(context.Background())

	got := strings.Join(fresh.got, " ")
	if strings.Contains(got, "bad") {
		t.Fatalf("the restart applied a config the cores had refused: %s", got)
	}
	// i1: its refused change is not stored, the version the core kept is.
	// i3: applied in the same push, so it is part of what the node runs.
	// i2: refused and never served before, so there is nothing to restore.
	if len(fresh.got) != 2 || !strings.Contains(got, "good-1") || !strings.Contains(got, "good-3") {
		t.Fatalf("restored %v, want good-1 and good-3", fresh.got)
	}
}

// The chain block goes the same way: a refused chain keeps the stored one, and
// a refused userCore keeps the hand-off the cores had while the chain process
// takes its new block.
func TestAcceptedPushKeepsThePreviousChainPartsThatWereRefused(t *testing.T) {
	oldChain := chainBlock()
	oldChain.SocksPassword = "old-chain-password-000000000000000"
	newChain := chainBlock()
	newChain.UserCore = &dto.ChainUserCore{Engine: "hysteria"} // halves do not match
	prev := dto.ApplyInboundsRequest{Chain: oldChain}
	req := dto.ApplyInboundsRequest{Chain: newChain}

	out := acceptedPush(prev, req, pushOutcome{chainRefused: true})
	if out.Chain != oldChain {
		t.Fatalf("a refused chain was stored over the previous one: %+v", out.Chain)
	}

	out = acceptedPush(prev, req, pushOutcome{userCoreRefused: true})
	if out.Chain == nil || out.Chain.SocksPassword != newChain.SocksPassword {
		t.Fatalf("the chain process took the new block, the store must have it: %+v", out.Chain)
	}
	if out.Chain.UserCore != oldChain.UserCore {
		t.Fatalf("the refused userCore was stored, want the previous hand-off: %+v", out.Chain.UserCore)
	}
	if req.Chain.UserCore.Engine != "hysteria" {
		t.Fatal("acceptedPush changed the request it was given")
	}
}
