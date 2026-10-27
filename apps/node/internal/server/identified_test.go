package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// idCore is an adapter whose wire config carries no id (mieru): the server
// hands it the push's id through core.IdentifiedApplier.
type idCore struct {
	fakeCore
	ids   []string
	plain int
}

func (c *idCore) ApplyInbound(int, json.RawMessage) error { c.plain++; return nil }
func (c *idCore) ApplyIdentifiedInbound(id string, _ int, _ json.RawMessage) error {
	c.ids = append(c.ids, id)
	return nil
}

// scopedCore records the order of ScopePush, the applies and RetainInbounds.
type scopedCore struct {
	idCore
	order []string
}

func (c *scopedCore) ScopePush(keep []string) {
	c.order = append(c.order, "scope:"+strings.Join(keep, ","))
}
func (c *scopedCore) ApplyIdentifiedInbound(id string, _ int, _ json.RawMessage) error {
	c.order = append(c.order, "apply:"+id)
	return nil
}
func (c *scopedCore) RetainInbounds(keep []string) error {
	c.order = append(c.order, "retain:"+strings.Join(keep, ","))
	return nil
}

// A-199: the adapter learns what the push keeps BEFORE its inbounds apply.
func TestAPushScopedAdapterIsScopedBeforeItsInboundsApply(t *testing.T) {
	mieru := &scopedCore{idCore: idCore{fakeCore: fakeCore{name: "mieru", engine: "mieru", running: true}}}
	s := serverWithStore(t, "", mieru)
	s.applyPush(context.Background(), dto.ApplyInboundsRequest{Inbounds: []dto.InboundDto{
		{ID: "new", Name: "one", Protocol: "mieru", Port: 0, Config: json.RawMessage(`{"mtu":1400}`)},
	}})
	if got := strings.Join(mieru.order, " "); got != "scope:new apply:new retain:new" {
		t.Fatalf("order %q", got)
	}
}

func TestAnIdentifiedApplierGetsThePushsInboundIDs(t *testing.T) {
	mieru := &idCore{fakeCore: fakeCore{name: "mieru", engine: "mieru", running: true}}
	s := serverWithStore(t, "", mieru)
	s.applyPush(context.Background(), dto.ApplyInboundsRequest{Inbounds: []dto.InboundDto{
		{ID: "in-1", Name: "one", Protocol: "mieru", Port: 0, Config: json.RawMessage(`{"mtu":1400}`)},
		{ID: "in-2", Name: "two", Protocol: "mieru", Port: 0, Config: json.RawMessage(`{"mtu":1400}`)},
	}})
	if mieru.plain != 0 || len(mieru.ids) != 2 || mieru.ids[0] != "in-1" || mieru.ids[1] != "in-2" {
		t.Fatalf("ids %v, plain ApplyInbound calls %d: want in-1, in-2 through the identified call only", mieru.ids, mieru.plain)
	}
}
