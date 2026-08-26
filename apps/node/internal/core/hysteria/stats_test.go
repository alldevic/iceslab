package hysteria

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// The traffic counters the panel bills against.
//
// GetStats is the only place hysteria numbers enter the fork, and every one of
// its error paths is a SOFT failure by design: a stats outage must not poison
// the cron poll for the node's other adapters. Soft failure is also how a
// permanently broken fetch looks exactly like a quiet node — so the paths are
// worth asking about one at a time, and the reply "users listed, counters zero"
// has to be told apart from "no users at all".
//
// The request itself carries two decisions that no shape check can see. The
// `?clear=1` makes hysteria RESET after the read, which is what makes the
// numbers deltas; drop it and every poll re-reports the running total, so a
// user's usage grows quadratically and quota enforcement cuts them off. And
// `tx` is the client's upload — mapping it to BytesOut instead of BytesIn is a
// swap that stays plausible in every log line.

// fakeHTTP records the last request and replays a canned answer.
type fakeHTTP struct {
	req    *http.Request
	status int
	body   string
	err    error
}

func (f *fakeHTTP) Do(req *http.Request) (*http.Response, error) {
	f.req = req
	if f.err != nil {
		return nil, f.err
	}
	status := f.status
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(bytes.NewBufferString(f.body)),
		Header:     make(http.Header),
	}, nil
}

func TestFetchTrafficStats_AsksForACountersReset(t *testing.T) {
	f := &fakeHTTP{body: `{"u-1":{"tx":10,"rx":20}}`}

	got, err := fetchTrafficStats(f, "127.0.0.1:9999", "s3cret")
	if err != nil {
		t.Fatalf("fetchTrafficStats: %v", err)
	}

	if want := "http://127.0.0.1:9999/traffic?clear=1"; f.req.URL.String() != want {
		t.Errorf("URL: got %q want %q — without clear=1 hysteria keeps the running total and every poll re-reports it as a delta",
			f.req.URL.String(), want)
	}
	if got := f.req.Header.Get("Authorization"); got != "s3cret" {
		t.Errorf("Authorization: got %q want %q", got, "s3cret")
	}
	if got["u-1"].Tx != 10 || got["u-1"].Rx != 20 {
		t.Errorf("counters: got %+v", got["u-1"])
	}
}

func TestFetchTrafficStats_ErrorPaths(t *testing.T) {
	cases := []struct {
		name    string
		client  *fakeHTTP
		wantSub string
	}{
		{"transport failure", &fakeHTTP{err: errors.New("connection refused")}, "connection refused"},
		{"wrong secret", &fakeHTTP{status: http.StatusUnauthorized, body: ``}, "HTTP 401"},
		{"server error", &fakeHTTP{status: http.StatusInternalServerError, body: ``}, "HTTP 500"},
		{"not JSON", &fakeHTTP{body: `<html>nope</html>`}, "decode"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := fetchTrafficStats(tc.client, "127.0.0.1:9999", "s")
			if err == nil {
				t.Fatalf("expected an error")
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Errorf("error %q should mention %q", err, tc.wantSub)
			}
		})
	}
}

func statsAdapter(t *testing.T, client HTTPClient, users ...core.User) *Adapter {
	t.Helper()
	a := New(Config{
		TrafficStatsListen: "127.0.0.1:9999",
		TrafficStatsSecret: "s3cret",
		HTTPClient:         client,
	}, quietLogger())
	for _, u := range users {
		if err := a.AddUser(u); err != nil {
			t.Fatalf("AddUser: %v", err)
		}
	}
	return a
}

func TestGetStats_MapsUploadAndDownloadTheRightWayRound(t *testing.T) {
	f := &fakeHTTP{body: `{"u-1":{"tx":111,"rx":222}}`}
	a := statsAdapter(t, f, core.User{UserID: "u-1", HysteriaPassword: "p1"})

	stats, err := a.GetStats()
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	if len(stats.Users) != 1 {
		t.Fatalf("users: got %d want 1", len(stats.Users))
	}
	// Distinct values on purpose: equal ones would pass a swapped mapping.
	if stats.Users[0].BytesIn != 111 || stats.Users[0].BytesOut != 222 {
		t.Errorf("counters: got in=%d out=%d want in=111 out=222 (tx is the client's upload)",
			stats.Users[0].BytesIn, stats.Users[0].BytesOut)
	}
}

// Every failure below must produce the SAME visible answer: the tracked users,
// with zero counters, and no error. The panel then sees a node whose users are
// registered and idle, which is the deliberate trade — but "no users at all"
// would be read as an empty node and is a different claim entirely.
func TestGetStats_SoftFailsWithTheUserListIntact(t *testing.T) {
	cases := []struct {
		name   string
		client HTTPClient
	}{
		{"traffic API unreachable", &fakeHTTP{err: errors.New("dial tcp: connection refused")}},
		{"traffic API rejects the secret", &fakeHTTP{status: http.StatusUnauthorized}},
		{"traffic API answers garbage", &fakeHTTP{body: `not json`}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := statsAdapter(t, tc.client,
				core.User{UserID: "u-1", HysteriaPassword: "p1"},
				core.User{UserID: "u-2", HysteriaPassword: "p2"},
			)

			stats, err := a.GetStats()
			if err != nil {
				t.Fatalf("GetStats must not surface the failure, got %v", err)
			}
			ids := userIDs(stats)
			if len(ids) != 2 || ids[0] != "u-1" || ids[1] != "u-2" {
				t.Fatalf("users: got %v want [u-1 u-2] — a dropped list reads as an empty node", ids)
			}
			for _, u := range stats.Users {
				if u.BytesIn != 0 || u.BytesOut != 0 {
					t.Errorf("%s: got in=%d out=%d, want zeroes", u.UserID, u.BytesIn, u.BytesOut)
				}
			}
		})
	}
}

// Half-configured stats must not reach the network at all: an adapter with a
// listen address but no secret would get a 401 on every poll forever.
func TestGetStats_SkipsTheFetchWhenStatsAreNotFullyConfigured(t *testing.T) {
	cases := []struct{ name, listen, secret string }{
		{"neither", "", ""},
		{"listen without secret", "127.0.0.1:9999", ""},
		{"secret without listen", "", "s3cret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeHTTP{body: `{"u-1":{"tx":5,"rx":5}}`}
			a := New(Config{
				TrafficStatsListen: tc.listen,
				TrafficStatsSecret: tc.secret,
				HTTPClient:         f,
			}, quietLogger())
			_ = a.AddUser(core.User{UserID: "u-1", HysteriaPassword: "p1"})

			stats, err := a.GetStats()
			if err != nil {
				t.Fatalf("GetStats: %v", err)
			}
			if f.req != nil {
				t.Errorf("polled %s with the stats API half-configured", f.req.URL)
			}
			if len(stats.Users) != 1 || stats.Users[0].UserID != "u-1" {
				t.Errorf("users: got %v want [u-1]", userIDs(stats))
			}
			if stats.Users[0].BytesIn != 0 || stats.Users[0].BytesOut != 0 {
				t.Errorf("counters should be zero without a stats endpoint, got %+v", stats.Users[0])
			}
		})
	}
}

// A user hysteria has never seen (registered, never connected) is absent from
// the response. Dropping them would make a paid-up user vanish from the panel.
func TestGetStats_KeepsUsersMissingFromTheResponse(t *testing.T) {
	f := &fakeHTTP{body: `{"u-1":{"tx":7,"rx":8}}`}
	a := statsAdapter(t, f,
		core.User{UserID: "u-1", HysteriaPassword: "p1"},
		core.User{UserID: "u-2", HysteriaPassword: "p2"},
	)

	stats, err := a.GetStats()
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	byID := map[string]core.UserStats{}
	for _, u := range stats.Users {
		byID[u.UserID] = u
	}
	if len(byID) != 2 {
		t.Fatalf("users: got %v want both", userIDs(stats))
	}
	if byID["u-1"].BytesIn != 7 || byID["u-1"].BytesOut != 8 {
		t.Errorf("u-1: got %+v", byID["u-1"])
	}
	if byID["u-2"].BytesIn != 0 || byID["u-2"].BytesOut != 0 {
		t.Errorf("u-2 never connected, want zeroes, got %+v", byID["u-2"])
	}
}

func userIDs(s *core.Stats) []string {
	out := make([]string, 0, len(s.Users))
	for _, u := range s.Users {
		out = append(out, u.UserID)
	}
	sort.Strings(out)
	return out
}
