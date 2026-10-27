package server

import (
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

type reportingAdapter struct {
	fakeAdapter
	report *dto.PolicyDrawn
}

func (r *reportingAdapter) PolicyDrawn() *dto.PolicyDrawn { return r.report }

// A-232: /healthz carries the router's policy report, and leaves the field out
// while there is none, which the panel reads as "keep what you had", not as
// "nothing left out".
func TestTheHealthcheckCarriesThePolicyReport(t *testing.T) {
	x := &reportingAdapter{fakeAdapter: fakeAdapter{name: "xray", engine: "xray"}}
	s := newServerWith(t, x)
	if h := healthOf(t, s); h.Policy != nil {
		t.Fatalf("no render yet, yet policy %+v", h.Policy)
	}
	x.report = &dto.PolicyDrawn{
		Drawing:    dto.PolicyDrawingLegacy,
		NotDrawn:   []dto.PolicyNotDrawn{{Exit: "cascade-link-out-chain-d7", Direction: 7}},
		RenderedAt: "2026-10-24T10:00:00Z",
	}
	h := healthOf(t, s)
	if h.Policy == nil || h.Policy.Drawing != "legacy" || len(h.Policy.NotDrawn) != 1 || h.Policy.RenderedAt == "" {
		t.Fatalf("policy %+v", h.Policy)
	}
}
