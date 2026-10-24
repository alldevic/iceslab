package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// pickyAdapter refuses one user and takes the rest.
type pickyAdapter struct {
	fakeAdapter
	refuse string
}

func (p *pickyAdapter) AddUser(u core.User) error {
	p.added = append(p.added, u)
	if u.UserID == p.refuse {
		return errors.New("refused")
	}
	return nil
}

func postAddUsers(t *testing.T, srv *Server, body string) (int, dto.AddUsersResponse) {
	t.Helper()
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/addUsers", strings.NewReader(body)))
	var resp dto.AddUsersResponse
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	return rr.Code, resp
}

// A-112: many users in one request, each applied as /addUser applies it, in
// order, with the result per user.
func TestAddUsersAppliesEveryEntryInOrder(t *testing.T) {
	hys := &fakeAdapter{name: "hysteria"}
	xry := &fakeAdapter{name: "xray"}
	srv := newServerWith(t, hys, xry)

	code, resp := postAddUsers(t, srv, `{"users":[
		{"userId":"u-1","shortId":"a","username":"alice","credentials":{"hysteriaPassword":"p1","xrayUuid":"x1"}},
		{"userId":"u-2","shortId":"b","username":"bob","credentials":{"hysteriaPassword":"p2","xrayUuid":"x2"}},
		{"userId":"u-3","shortId":"c","username":"carol","credentials":{"hysteriaPassword":"p3","xrayUuid":"x3"}}]}`)

	if code != http.StatusOK {
		t.Fatalf("status: got %d want 200", code)
	}
	if len(resp.Results) != 3 {
		t.Fatalf("results: got %d want 3: %+v", len(resp.Results), resp.Results)
	}
	for i, want := range []string{"u-1", "u-2", "u-3"} {
		if r := resp.Results[i]; r.UserID != want || !r.OK || r.Error != "" {
			t.Errorf("result %d: got %+v want %s ok", i, r, want)
		}
		if hys.added[i].UserID != want || xry.added[i].UserID != want {
			t.Errorf("entry %d reached the cores out of order: %s / %s", i, hys.added[i].UserID, xry.added[i].UserID)
		}
	}
	if hys.added[1].HysteriaPassword != "p2" || xry.added[2].XrayUUID != "x3" {
		t.Errorf("credentials did not travel per entry: %+v %+v", hys.added, xry.added)
	}
}

// One refused user is that user's result; the users after it still land, and
// the request itself answers 200.
func TestAddUsersReportsARefusalPerUser(t *testing.T) {
	picky := &pickyAdapter{fakeAdapter: fakeAdapter{name: "hysteria"}, refuse: "u-2"}
	srv := newServerWith(t, picky)

	code, resp := postAddUsers(t, srv, `{"users":[
		{"userId":"u-1","credentials":{"hysteriaPassword":"p"}},
		{"userId":"u-2","credentials":{"hysteriaPassword":"p"}},
		{"userId":"u-3","credentials":{"hysteriaPassword":"p"}}]}`)

	if code != http.StatusOK {
		t.Fatalf("status: got %d want 200", code)
	}
	if len(picky.added) != 3 {
		t.Errorf("the user after the refusal was not applied: %+v", picky.added)
	}
	if !resp.Results[0].OK || resp.Results[1].OK || !resp.Results[2].OK {
		t.Errorf("results: %+v", resp.Results)
	}
	if !strings.Contains(resp.Results[1].Error, "hysteria") {
		t.Errorf("the refusal does not name the core: %q", resp.Results[1].Error)
	}
}

// The scope travels per entry exactly as on /addUser: an empty list takes the
// user off the node.
func TestAddUsersKeepsTheScopePerEntry(t *testing.T) {
	hys := &fakeAdapter{name: "hysteria"}
	srv := newServerWith(t, hys)

	code, _ := postAddUsers(t, srv, `{"users":[
		{"userId":"u-1","credentials":{"hysteriaPassword":"p"}},
		{"userId":"u-2","credentials":{"hysteriaPassword":"p"},"inboundIds":[]}]}`)

	if code != http.StatusOK {
		t.Fatalf("status: got %d want 200", code)
	}
	if len(hys.added) != 1 || hys.added[0].UserID != "u-1" {
		t.Errorf("added: %+v", hys.added)
	}
	if len(hys.removed) != 1 || hys.removed[0] != "u-2" {
		t.Errorf("an empty scope should remove: %+v", hys.removed)
	}
}

func TestAddUsersIsPostOnly(t *testing.T) {
	srv := newServerWith(t, &fakeAdapter{name: "hysteria"})
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/addUsers", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status: got %d want 405", rr.Code)
	}
}
