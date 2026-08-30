package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// A core that could not read its counters makes the WHOLE per-user list
// incomplete, and only the node can say so.
//
// The panel sums a user's cumulative rows across cores before comparing them to
// its snapshot, so a core dropping out of the payload is indistinguishable from
// a core whose counters reset: the sum falls, the snapshot is re-baselined low,
// and the next successful poll bills the absent core's entire since-core-start
// counter. Measured live 2026-08-30 on a node running xray and sing-box for one
// user - one blocked poll on sing-box's stats endpoint, no traffic at all, and
// the user went from 1 156 229 to 1 672 312 bytes.
//
// Emitting no rows (what xray already did) does not help, which is why the flag
// exists rather than another convention about rows.

// degradingAdapter reports stats that are either whole or admittedly partial.
type degradingAdapter struct {
	fakeAdapter
	stats *core.Stats
	err   error
}

func (d *degradingAdapter) GetStats() (*core.Stats, error) {
	if d.err != nil {
		return nil, d.err
	}
	return d.stats, nil
}

func statsResponse(t *testing.T, srv *Server) dto.GetStatsResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/stats", nil)
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", rr.Code, rr.Body.String())
	}
	var out dto.GetStatsResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

func TestStatsResponseIsNotDegradedWhenEveryCoreAnswered(t *testing.T) {
	// The control first: a flag that is always on says nothing.
	a := &degradingAdapter{
		fakeAdapter: fakeAdapter{name: "xray", engine: "xray"},
		stats: &core.Stats{
			Users:      []core.UserStats{{UserID: "u-1", BytesOut: 10}},
			Cumulative: true,
		},
	}
	out := statsResponse(t, newServerWith(t, a))
	if out.StatsDegraded {
		t.Error("a poll in which every core answered was reported as degraded")
	}
	if len(out.Users) != 1 || !out.Users[0].Cumulative {
		t.Errorf("the cumulative row did not survive: %+v", out.Users)
	}
}

func TestOneCoreThatCouldNotReadMarksTheWholePollDegraded(t *testing.T) {
	healthy := &degradingAdapter{
		fakeAdapter: fakeAdapter{name: "xray", engine: "xray"},
		stats: &core.Stats{
			Users:      []core.UserStats{{UserID: "u-1", BytesOut: 1_100_000}},
			Cumulative: true,
		},
	}
	// What the sing-box adapter now returns on a failed statsquery: no rows,
	// and an admission.
	blind := &degradingAdapter{
		fakeAdapter: fakeAdapter{name: "hysteria", engine: "singbox"},
		stats:       &core.Stats{Cumulative: true, Degraded: true},
	}
	out := statsResponse(t, newServerWith(t, healthy, blind))

	if !out.StatsDegraded {
		t.Fatal("a core that could not read its counters did not mark the poll degraded, " +
			"so the panel will re-baseline this user's snapshot to the surviving core alone")
	}
	// The rows that DID arrive still arrive: the panel decides what to do with
	// them, the node does not silently drop a healthy core's numbers.
	if len(out.Users) != 1 || out.Users[0].BytesOut != 1_100_000 {
		t.Errorf("the healthy core's row was lost: %+v", out.Users)
	}
}

func TestAHardGetStatsErrorAlsoDegradesThePoll(t *testing.T) {
	// An adapter that returns an error contributes nothing at all, which for a
	// user it also serves is the same missing row.
	healthy := &degradingAdapter{
		fakeAdapter: fakeAdapter{name: "xray", engine: "xray"},
		stats: &core.Stats{
			Users:      []core.UserStats{{UserID: "u-1", BytesOut: 5}},
			Cumulative: true,
		},
	}
	broken := &degradingAdapter{
		fakeAdapter: fakeAdapter{name: "hysteria", engine: "singbox"},
		err:         errors.New("boom"),
	}
	out := statsResponse(t, newServerWith(t, healthy, broken))
	if !out.StatsDegraded {
		t.Error("an adapter whose GetStats errored did not mark the poll degraded")
	}
}
