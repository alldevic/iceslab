package xray

import (
	"encoding/json"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// A-108, the agent's half. The panel names a cascade rule's way out by the
// drawing it SENT; the agent draws what it can run. A chain refused with none
// accepted before leaves xray on the legacy drawing, and the hand-over name
// the panel sent is then an outbound the config does not have: `xray -test`
// refuses the whole push, the users' inbounds with it. The name is fitted to
// what this render draws.

func cascadeRule(exit string) dto.NodePolicyRule {
	return dto.NodePolicyRule{
		Match:  dto.NodePolicyMatch{Domain: []string{"youtube.com"}},
		Action: dto.NodePolicyAction{Kind: dto.PolicyActionCascade, Exit: exit},
	}
}

func handoverFragments() *CascadeFragments {
	return &CascadeFragments{
		RoutingRules: []json.RawMessage{
			json.RawMessage(`{"type":"field","network":"tcp,udp","outboundTag":"cascade-link-out-chain-d1"}`),
		},
		Outbounds: []json.RawMessage{
			json.RawMessage(`{"tag":"cascade-link-out-chain-d1","protocol":"socks"}`),
		},
	}
}

func outboundOfDomainRule(rules []map[string]any) any {
	i := indexOfRule(rules, func(r map[string]any) bool {
		d, ok := r["domain"].([]any)
		return ok && len(d) == 1 && d[0] == "youtube.com"
	})
	if i < 0 {
		return nil
	}
	return rules[i]["outboundTag"]
}

func TestACascadeRuleTakesTheNameOfTheDrawingInForce(t *testing.T) {
	// The chain refused: xray on the legacy drawing, the panel sent the hand-over name.
	if got := outboundOfDomainRule(renderedRules(t, []dto.NodePolicyRule{cascadeRule("cascade-link-out-chain-d1")}, entryFragments())); got != "cascade-link-out-d1-0" {
		t.Fatalf("legacy drawing: rule goes to %v, want cascade-link-out-d1-0", got)
	}
	// The other way round: the hand-over drawn, the legacy name sent.
	if got := outboundOfDomainRule(renderedRules(t, []dto.NodePolicyRule{cascadeRule("cascade-link-out-d1-0")}, handoverFragments())); got != "cascade-link-out-chain-d1" {
		t.Fatalf("hand-over drawing: rule goes to %v, want cascade-link-out-chain-d1", got)
	}
	// The name drawn is kept as it is.
	if got := outboundOfDomainRule(renderedRules(t, []dto.NodePolicyRule{cascadeRule("cascade-link-out-chain-d1")}, handoverFragments())); got != "cascade-link-out-chain-d1" {
		t.Fatalf("drawn name changed to %v", got)
	}
}

func TestACascadeRuleWithNeitherNameDrawnIsDroppedAndTheRestRenders(t *testing.T) {
	block := dto.NodePolicyRule{
		Match:  dto.NodePolicyMatch{Domain: []string{"ads.example"}},
		Action: dto.NodePolicyAction{Kind: dto.PolicyActionBlock},
	}
	rules := renderedRules(t, []dto.NodePolicyRule{cascadeRule("cascade-link-out-chain-d7"), block}, nil)
	if got := outboundOfDomainRule(rules); got != nil {
		t.Fatalf("a rule to a way out nothing draws was rendered to %v", got)
	}
	if indexOfRule(rules, func(r map[string]any) bool {
		d, ok := r["domain"].([]any)
		return ok && len(d) == 1 && d[0] == "ads.example"
	}) < 0 {
		t.Fatal("the block rule beside it was lost")
	}
}
