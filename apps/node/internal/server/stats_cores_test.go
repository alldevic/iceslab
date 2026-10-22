package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

/*
A-152, A-163, 22.10. The node total was one number summed over cumulative and
delta cores under an OR'ed flag, so a mixed node's history read a restart and
wrote 0. And a core that did not answer sent zeros as a fact: a user seen by
two cumulative cores had one snapshot re-baselined to 0 and then billed the
core's whole counter on the next good poll. Now each adapter, named by its
(protocol, engine) pair, reports its own total with its own flag, and one that
did not answer says noData with its users left out.
*/

func statsOf(t *testing.T, srv *Server) dto.GetStatsResponse {
	t.Helper()
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/stats", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d", rr.Code)
	}
	var resp dto.GetStatsResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestEachAdapterReportsItsOwnTotalAndAMissedPollIsNoData(t *testing.T) {
	native := &fakeAdapter{name: "xray", engine: "xray", stats: &core.Stats{
		Users:        []core.UserStats{{UserID: "u", BytesIn: 1000, BytesOut: 2000}},
		TotalBytesIn: 1500, TotalBytesOut: 2500, Cumulative: true,
	}}
	// The sing-box adapter of the same protocol: a separate process with
	// counters of its own, which missed this poll.
	viaSingbox := &fakeAdapter{name: "xray", engine: "singbox", stats: &core.Stats{NoData: true, Cumulative: true}}
	// A delta core with no totals of its own.
	awg := &fakeAdapter{name: "amneziawg", engine: "amneziawg", stats: &core.Stats{
		Users: []core.UserStats{{UserID: "u", BytesIn: 7, BytesOut: 9}, {UserID: "w", BytesIn: 3, BytesOut: 1}},
	}}
	broken := &fakeAdapter{name: "hysteria", engine: "hysteria", failOnStats: true}

	resp := statsOf(t, newServerWith(t, native, viaSingbox, awg, broken))

	cores := map[string]dto.CoreTrafficTotal{}
	for _, c := range resp.Cores {
		cores[string(c.Protocol)+"|"+string(c.Engine)] = c
	}
	if len(cores) != 4 {
		t.Fatalf("cores %+v, want one entry per adapter", resp.Cores)
	}
	if c := cores["xray|xray"]; c.BytesIn != 1500 || c.BytesOut != 2500 || !c.Cumulative || c.NoData {
		t.Errorf("native xray total %+v, want its own 1500/2500 cumulative", c)
	}
	if c := cores["xray|singbox"]; !c.NoData || c.BytesIn != 0 {
		t.Errorf("sing-box xray %+v, want noData", c)
	}
	if c := cores["amneziawg|amneziawg"]; c.BytesIn != 10 || c.BytesOut != 10 || c.Cumulative || c.NoData {
		t.Errorf("awg total %+v, want the sum of its users 10/10, delta", c)
	}
	if c := cores["hysteria|hysteria"]; !c.NoData {
		t.Errorf("an adapter whose GetStats failed %+v, want noData", c)
	}

	// The users of the silent adapter are not in the list, and every entry
	// names its engine.
	for _, u := range resp.Users {
		if u.Engine == "singbox" || u.Engine == "hysteria" {
			t.Errorf("a user of a silent adapter is in the list: %+v", u)
		}
		if u.Engine == "" {
			t.Errorf("an entry without its engine: %+v", u)
		}
	}
	if len(resp.Users) != 3 {
		t.Errorf("users %+v, want u on xray, u and w on awg", resp.Users)
	}
}
