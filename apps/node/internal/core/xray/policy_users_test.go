package xray

import (
	"reflect"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// A-277: a rule of the node's policy into a cascade direction carries the
// users that direction's door lets through (the panel's entry gate), so a
// squad the cascade is switched off for is not taken into it by the policy.

func gatedRule(users []string) dto.NodePolicyRule {
	r := cascadeRule("cascade-link-out-chain-d1")
	r.Action.Users = users
	return r
}

func domainRule(rules []map[string]any) map[string]any {
	i := indexOfRule(rules, func(r map[string]any) bool {
		d, ok := r["domain"].([]any)
		return ok && len(d) == 1 && d[0] == "youtube.com"
	})
	if i < 0 {
		return nil
	}
	return rules[i]
}

func TestACascadeRuleCarriesTheUsersItsDoorLetsThrough(t *testing.T) {
	r := domainRule(renderedRules(t, []dto.NodePolicyRule{gatedRule([]string{"u-alice", "u-carol"})}, handoverFragments()))
	if r == nil {
		t.Fatal("the rule was not drawn")
	}
	if got := r["user"]; !reflect.DeepEqual(got, []any{"u-alice", "u-carol"}) {
		t.Fatalf("user = %v", got)
	}
}

func TestACascadeRuleWithoutUsersIsForEverybodyAsBefore(t *testing.T) {
	r := domainRule(renderedRules(t, []dto.NodePolicyRule{gatedRule(nil)}, handoverFragments()))
	if r == nil {
		t.Fatal("the rule was not drawn")
	}
	if _, ok := r["user"]; ok {
		t.Fatalf("no list sent, yet a user condition: %v", r)
	}
}

// An empty list would draw no condition, which xray reads as everyone.
func TestACascadeRuleWithAnEmptyUserListIsLeftOutAndReported(t *testing.T) {
	block := dto.NodePolicyRule{
		Match:  dto.NodePolicyMatch{Domain: []string{"ads.example"}},
		Action: dto.NodePolicyAction{Kind: dto.PolicyActionBlock},
	}
	kept, dropped := fitCascadeExits([]dto.NodePolicyRule{gatedRule([]string{}), block}, handoverFragments())
	if len(kept) != 1 || kept[0].Action.Kind != dto.PolicyActionBlock {
		t.Fatalf("kept %+v", kept)
	}
	if want := []dto.PolicyNotDrawn{{Exit: "cascade-link-out-chain-d1", Direction: 1}}; !reflect.DeepEqual(dropped, want) {
		t.Fatalf("dropped %+v", dropped)
	}
	if domainRule(renderedRules(t, []dto.NodePolicyRule{gatedRule([]string{})}, handoverFragments())) != nil {
		t.Fatal("an empty list was drawn as a rule for everyone")
	}
}
