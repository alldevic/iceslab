package server

import (
	"context"
	"encoding/json"
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
