package server

import (
	"context"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

/*
11.5: a sing-box entry's hand-off goes to the instance of ITS protocol. Every
sing-box instance answers to the engine "singbox", so the engine alone would
hand it to all of them: other profiles of the node would leave through the
cascade, or be refused.
*/

func singboxBlock(protocol dto.ProtocolName, socks *dto.ChainUserCoreSocks) *dto.NodeChain {
	b := chainBlock()
	b.UserCore = &dto.ChainUserCore{Engine: "singbox", Protocol: protocol, Socks: socks}
	return b
}

var singboxSocks = &dto.ChainUserCoreSocks{Port: 26000, Username: "chain", Password: "chain-socks-fixture-password-0000"}

func TestASingboxHandoffReachesOnlyTheInstanceOfItsProtocol(t *testing.T) {
	tuic := &cascadeCore{fakeCore: fakeCore{name: "tuic", engine: "singbox", running: true}}
	anytls := &cascadeCore{fakeCore: fakeCore{name: "anytls", engine: "singbox", running: true}}
	xray := &cascadeCore{fakeCore: fakeCore{name: "vless", engine: "xray", running: true}}
	hy := &cascadeCore{fakeCore: fakeCore{name: "hysteria", engine: "hysteria", running: true}}
	var logs strings.Builder
	s, _ := serverWithChain(t, &logs, tuic, anytls, xray, hy)

	s.applyPush(context.Background(), dto.ApplyInboundsRequest{Chain: singboxBlock("anytls", singboxSocks)})

	if len(anytls.got) != 1 || string(anytls.got[0]) != `{"port":26000,"username":"chain","password":"chain-socks-fixture-password-0000"}` {
		t.Fatalf("anytls got %s", anytls.got)
	}
	for name, c := range map[string]*cascadeCore{"tuic": tuic, "xray": xray, "hysteria": hy} {
		if len(c.got) != 1 || len(c.got[0]) != 0 {
			t.Errorf("%s was handed %q, want nothing", name, c.got)
		}
	}
	if strings.Contains(logs.String(), "no core on this node draws the cascade") {
		t.Errorf("the alarm fired though the instance took it:\n%s", logs.String())
	}
}

func TestASingboxHandoffWithNoInstanceOfItsProtocolSaysSo(t *testing.T) {
	tuic := &cascadeCore{fakeCore: fakeCore{name: "tuic", engine: "singbox", running: true}}
	var logs strings.Builder
	s, _ := serverWithChain(t, &logs, tuic)

	s.applyPush(context.Background(), dto.ApplyInboundsRequest{Chain: singboxBlock("shadowtls", singboxSocks)})

	if len(tuic.got) != 1 || len(tuic.got[0]) != 0 {
		t.Fatalf("an instance of another protocol was handed %q", tuic.got)
	}
	if !strings.Contains(logs.String(), "no core on this node draws the cascade") {
		t.Fatalf("no alarm for a hand-off nobody took:\n%s", logs.String())
	}
}

// A block that does not add up goes to nobody, and every core keeps what it
// had: told nil, an entry would draw direct.
func TestAnInconsistentSingboxBlockIsDeliveredToNobody(t *testing.T) {
	for name, block := range map[string]*dto.NodeChain{
		"no socks":    singboxBlock("tuic", nil),
		"no protocol": singboxBlock("", singboxSocks),
	} {
		tuic := &cascadeCore{fakeCore: fakeCore{name: "tuic", engine: "singbox", running: true}}
		s, _ := serverWithChain(t, nil, tuic)
		s.applyPush(context.Background(), dto.ApplyInboundsRequest{Chain: block})
		if len(tuic.got) != 0 {
			t.Errorf("%s: a refused block reached a core: %q", name, tuic.got)
		}
	}
}
