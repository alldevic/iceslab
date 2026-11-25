package server

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// RetainInbounds is how an adapter that holds several inbounds learns one was
// DELETED: the push is applied per inbound, so a removal is invisible to it
// unless the full set it keeps is handed over afterwards. The case that matters
// is the empty one, "the last inbound of this kind was removed". Skipping the
// call there, the tempting optimisation, leaves the deleted inbound serving
// forever.
//
// Not covered elsewhere: identified_test.go and restore_test.go reach
// RetainInbounds only with a non-empty set.

// A push that carries nothing at all still reconciles every adapter.
func TestAPushWithNoInboundsStillReachesRetainInbounds(t *testing.T) {
	xray := &recordingCore{fakeCore: fakeCore{name: "xray", engine: "xray", running: true}}
	s := serverWithStore(t, "", xray)

	s.applyPush(context.Background(), dto.ApplyInboundsRequest{Inbounds: []dto.InboundDto{}})

	if len(xray.retained) != 1 {
		t.Fatalf("RetainInbounds called %d times on an empty push, want once: "+
			"an empty set is how the last inbound is removed", len(xray.retained))
	}
	if len(xray.retained[0]) != 0 {
		t.Errorf("keep set = %v, want empty", xray.retained[0])
	}
}

// An adapter the push brought nothing for is told so, while the one it did
// bring something for is told what it keeps.
func TestAnAdapterThePushBroughtNothingForIsToldToKeepNothing(t *testing.T) {
	xray := &recordingCore{fakeCore: fakeCore{name: "xray", engine: "xray", running: true}}
	hys := &recordingCore{fakeCore: fakeCore{name: "hysteria", engine: "hysteria", running: true}}
	s := serverWithStore(t, "", xray, hys)

	// port:0 keeps ensureInboundFirewall from shelling out to ufw.
	s.applyPush(context.Background(), dto.ApplyInboundsRequest{Inbounds: []dto.InboundDto{
		{ID: "i1", Name: "reality", Protocol: dto.ProtocolXray, Port: 0, Config: json.RawMessage(`{}`)},
	}})

	if len(xray.retained) != 1 || len(xray.retained[0]) != 1 || xray.retained[0][0] != "i1" {
		t.Errorf("xray keep sets = %v, want [[i1]]", xray.retained)
	}
	if len(hys.retained) != 1 {
		t.Fatalf("hysteria RetainInbounds called %d times, want once even though the push had nothing for it", len(hys.retained))
	}
	if len(hys.retained[0]) != 0 {
		t.Errorf("hysteria keep set = %v, want empty: it holds nothing the push kept", hys.retained[0])
	}
}
