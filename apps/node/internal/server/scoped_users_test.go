package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// scopedAdapter records AddUserOn beside fakeAdapter's AddUser/RemoveUser.
type scopedAdapter struct {
	fakeAdapter
	on [][]string
}

func (s *scopedAdapter) AddUserOn(_ core.User, ids []string) error {
	s.on = append(s.on, ids)
	return nil
}

// A-022: inboundIds on the wire. Each adapter gets the ids it holds; one the
// user is named on none of loses them; nil keeps the old "everywhere"; [] is
// a removal everywhere.
func TestAddUserGoesOnlyToTheNamedInbounds(t *testing.T) {
	xray := &scopedAdapter{fakeAdapter: fakeAdapter{name: "xray", engine: "xray"}}
	hy := &fakeAdapter{name: "hysteria", engine: "hysteria"}
	tuic := &fakeAdapter{name: "tuic", engine: "singbox"}
	srv := newServerWith(t, xray, hy, tuic)
	srv.applyPush(context.Background(), dto.ApplyInboundsRequest{Inbounds: []dto.InboundDto{
		{ID: "x1", Protocol: "xray", Config: json.RawMessage(`{}`)},
		{ID: "x2", Protocol: "xray", Config: json.RawMessage(`{}`)},
		{ID: "h1", Protocol: "hysteria", Config: json.RawMessage(`{}`)},
		{ID: "t1", Protocol: "tuic", Engine: "singbox", Config: json.RawMessage(`{}`)},
	}})

	add := func(ids *[]string) {
		t.Helper()
		body, _ := json.Marshal(dto.AddUserRequest{UserID: "u-1", Username: "alice", InboundIDs: ids})
		rr := httptest.NewRecorder()
		srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/addUser", strings.NewReader(string(body))))
		if rr.Code != http.StatusOK {
			t.Fatalf("addUser: %d %s", rr.Code, rr.Body.String())
		}
	}

	add(&[]string{"x2", "h1", "elsewhere"})
	if len(xray.on) != 1 || strings.Join(xray.on[0], ",") != "x2" || len(xray.added) != 0 {
		t.Fatalf("xray: on=%v added=%d, want AddUserOn [x2]", xray.on, len(xray.added))
	}
	if len(hy.added) != 1 || len(hy.removed) != 0 {
		t.Fatalf("hysteria named: added=%d removed=%v", len(hy.added), hy.removed)
	}
	if len(tuic.added) != 0 || len(tuic.removed) != 1 {
		t.Fatalf("tuic not named: added=%d removed=%v, want a removal", len(tuic.added), tuic.removed)
	}

	add(nil)
	if len(xray.added) != 1 || len(tuic.added) != 1 {
		t.Fatalf("nil must keep the old every-adapter add: xray=%d tuic=%d", len(xray.added), len(tuic.added))
	}

	add(&[]string{})
	if len(xray.removed) != 1 || len(hy.removed) != 1 || len(tuic.removed) != 2 {
		t.Fatalf("[] must remove everywhere: xray=%v hy=%v tuic=%v", xray.removed, hy.removed, tuic.removed)
	}
}
