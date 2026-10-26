package server

import (
	"context"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// waitingCore holds its inbound and does not serve yet by design (A-275:
// mita refuses a proxy with no user).
type waitingCore struct {
	fakeAdapter
	reason string
}

func (c *waitingCore) Waiting() string { return c.reason }

var _ core.Waiter = (*waitingCore)(nil)

func TestACoreWaitingForItsFirstUserSaysSoAndDoesNotDegradeTheNode(t *testing.T) {
	xray := &idleCore{fakeAdapter: fakeAdapter{name: "xray", engine: "xray"}}
	mieru := &waitingCore{fakeAdapter: fakeAdapter{name: "mieru", engine: "mieru"}, reason: core.NoUsersReason}
	s := newServerWith(t, xray, mieru)
	s.applyPush(context.Background(), dto.ApplyInboundsRequest{
		Inbounds: []dto.InboundDto{inboundFor("xray", "xray"), inboundFor("mieru", "mieru")},
	})

	h := healthOf(t, s)
	c := coreOf(h, "mieru")
	if c.Running || c.Reason != core.NoUsersReason {
		t.Errorf("the waiting core reads %+v, want running:false reason %q", c, core.NoUsersReason)
	}
	if h.Status != "ok" {
		t.Errorf("node status %q: a core waiting for its first user must not degrade it", h.Status)
	}

	// The first user arrives: it serves and says nothing.
	mieru.reason = ""
	if c := coreOf(healthOf(t, s), "mieru"); !c.Running || c.Reason != "" {
		t.Errorf("the serving core reads %+v", c)
	}
}
