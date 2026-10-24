package xray

import (
	"context"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// A-232: the node reports what the render in force did with the node policy,
// from the same call that fitted the cascade rules to the drawing, and only
// once that render is in force.

func TestTheRenderReportsTheDrawingAndTheRulesItLeftOut(t *testing.T) {
	var report *dto.PolicyDrawn
	policy := []dto.NodePolicyRule{cascadeRule("cascade-link-out-chain-d1"), cascadeRule("cascade-link-out-chain-d7")}
	if _, err := renderMultiConfigInto([]InboundConfig{validInbound()}, nil, entryFragments(), 10085, policy, nil, &report); err != nil {
		t.Fatal(err)
	}
	if report == nil || report.Drawing != dto.PolicyDrawingLegacy {
		t.Fatalf("report %+v, want the legacy drawing", report)
	}
	// d1 was renamed onto the legacy leg; d7 has no leg at all.
	if len(report.NotDrawn) != 1 || report.NotDrawn[0] != (dto.PolicyNotDrawn{Exit: "cascade-link-out-chain-d7", Direction: 7}) {
		t.Fatalf("notDrawn %+v", report.NotDrawn)
	}

	report = nil
	if _, err := renderMultiConfigInto([]InboundConfig{validInbound()}, nil, handoverFragments(), 10085, nil, nil, &report); err != nil {
		t.Fatal(err)
	}
	if report.Drawing != dto.PolicyDrawingHandover || report.NotDrawn == nil || len(report.NotDrawn) != 0 {
		t.Fatalf("hand-over with no policy: %+v (notDrawn must be an empty list, not null)", report)
	}
}

func TestOnlyARenderInForceReplacesTheReport(t *testing.T) {
	a := policyAdapter(t)
	a.mu.Lock()
	a.inbounds = map[string]InboundConfig{"i1": validInbound()}
	a.cascade = entryFragments()
	a.policy = []dto.NodePolicyRule{cascadeRule("cascade-link-out-chain-d7")}
	a.mu.Unlock()
	if err := a.regenerateAndRestart(context.Background()); err != nil {
		t.Fatal(err)
	}
	first := a.PolicyDrawn()
	if first == nil || first.RenderedAt == "" || len(first.NotDrawn) != 1 {
		t.Fatalf("after an accepted render: %+v", first)
	}

	// A render that is refused (an action this core cannot name) keeps the last report.
	a.mu.Lock()
	a.policy = []dto.NodePolicyRule{{Action: dto.NodePolicyAction{Kind: "elsewhere"}}}
	a.mu.Unlock()
	if err := a.regenerateAndRestart(context.Background()); err == nil {
		t.Fatal("a policy with an unknown action was accepted")
	}
	if got := a.PolicyDrawn(); got != first {
		t.Fatalf("a refused render replaced the report: %+v", got)
	}
}
