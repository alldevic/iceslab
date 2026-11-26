package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// reconcilingAdapter adds core.UserReconciler to fakeAdapter.
type reconcilingAdapter struct {
	fakeAdapter
	kept [][]string
	n    int
	err  error
}

func (r *reconcilingAdapter) RetainUsers(keep []string) (int, error) {
	r.kept = append(r.kept, keep)
	return r.n, r.err
}

func postRetain(t *testing.T, srv *Server, body string) dto.RetainUsersResponse {
	t.Helper()
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/retainUsers", strings.NewReader(body)))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var out dto.RetainUsersResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRetainUsers_AdaptersWithoutTheInterfaceAreSkipped(t *testing.T) {
	srv := newServerWith(t, &fakeAdapter{name: "xray"})
	if out := postRetain(t, srv, `{"userIds":["a"]}`); !out.OK || out.Reconciled != 0 {
		t.Fatalf("got %+v, want ok and zero", out)
	}
}

func TestRetainUsers_SeveralAdaptersAndOneFailing(t *testing.T) {
	bad := &reconcilingAdapter{fakeAdapter: fakeAdapter{name: "amneziawg"}, err: errors.New("boom")}
	good := &reconcilingAdapter{fakeAdapter: fakeAdapter{name: "wireguard"}, n: 2}
	srv := newServerWith(t, bad, &fakeAdapter{name: "xray"}, good)
	out := postRetain(t, srv, `{"userIds":["a","b"]}`)
	if !out.OK || out.Reconciled != 2 {
		t.Fatalf("got %+v, want ok and 2", out)
	}
	if len(bad.kept) != 1 || len(good.kept) != 1 || strings.Join(good.kept[0], ",") != "a,b" {
		t.Fatalf("not every reconciler was called: %v %v", bad.kept, good.kept)
	}
}

func TestRetainUsers_EmptySetIsExecuted(t *testing.T) {
	a := &reconcilingAdapter{fakeAdapter: fakeAdapter{name: "amneziawg"}, n: 3}
	srv := newServerWith(t, a)
	if out := postRetain(t, srv, `{"userIds":[]}`); out.Reconciled != 3 || len(a.kept) != 1 || len(a.kept[0]) != 0 {
		t.Fatalf("got %+v kept=%v", out, a.kept)
	}
}
