package hysteria

import (
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// kickClient records the requests to the traffic API and answers with status.
type kickClient struct {
	mu     sync.Mutex
	status int
	reqs   []string
}

func (k *kickClient) Do(r *http.Request) (*http.Response, error) {
	body, _ := io.ReadAll(r.Body)
	k.mu.Lock()
	defer k.mu.Unlock()
	k.reqs = append(k.reqs, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization")+" "+string(body))
	return &http.Response{StatusCode: k.status, Body: io.NopCloser(strings.NewReader(""))}, nil
}

func (k *kickClient) sent() []string {
	k.mu.Lock()
	defer k.mu.Unlock()
	return append([]string(nil), k.reqs...)
}

func kickAdapter(client HTTPClient, stats bool) *Adapter {
	cfg := Config{HTTPClient: client}
	if stats {
		cfg.TrafficStatsListen = "127.0.0.1:9999"
		cfg.TrafficStatsSecret = "fixture-stats-secret-not-a-secret"
	}
	a := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	_ = a.AddUser(core.User{UserID: "u1", HysteriaPassword: "p1"})
	return a
}

// A-120: a removed user's open sessions are kicked, by the id the auth
// callback gave hysteria, after the password is gone.
func TestRemovingAUserKicksTheirOpenSessions(t *testing.T) {
	k := &kickClient{status: http.StatusOK}
	a := kickAdapter(k, true)
	if err := a.RemoveUser("u1"); err != nil {
		t.Fatal(err)
	}
	if _, ok := a.LookupByPassword("p1"); ok {
		t.Error("the password still authenticates after the removal")
	}
	want := `POST /kick fixture-stats-secret-not-a-secret ["u1"]`
	if got := k.sent(); len(got) != 1 || got[0] != want {
		t.Fatalf("requests = %q, want one %q", got, want)
	}
}

// Removing someone this adapter never held asks nothing: the server calls
// RemoveUser for every core a user is not scoped to.
func TestRemovingAnUnknownUserKicksNobody(t *testing.T) {
	k := &kickClient{status: http.StatusOK}
	a := kickAdapter(k, true)
	if err := a.RemoveUser("someone-else"); err != nil {
		t.Fatal(err)
	}
	if got := k.sent(); len(got) != 0 {
		t.Fatalf("requests for a user never held: %q", got)
	}
}

// A kick that fails fails the call, and the panel's retry kicks again
// although the password is already gone; once it took, nothing more.
func TestAFailedKickIsRetriedByTheNextRemoval(t *testing.T) {
	k := &kickClient{status: http.StatusInternalServerError}
	a := kickAdapter(k, true)
	if err := a.RemoveUser("u1"); err == nil || !strings.Contains(err.Error(), "kick") {
		t.Fatalf("a failed kick must fail the call in words, got %v", err)
	}
	k.mu.Lock()
	k.status = http.StatusOK
	k.mu.Unlock()
	if err := a.RemoveUser("u1"); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if err := a.RemoveUser("u1"); err != nil {
		t.Fatal(err)
	}
	if got := k.sent(); len(got) != 2 {
		t.Fatalf("requests = %q, want the failed kick and its retry, then nothing", got)
	}
}

// A reissued password replaces the old one: the old refuses, the new passes,
// and the sessions opened with the old are kicked.
func TestAReissuedPasswordRetiresTheOldOne(t *testing.T) {
	k := &kickClient{status: http.StatusOK}
	a := kickAdapter(k, true)
	if err := a.AddUser(core.User{UserID: "u1", HysteriaPassword: "p2"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := a.LookupByPassword("p1"); ok {
		t.Error("the old password still authenticates after the reissue")
	}
	if id, ok := a.LookupByPassword("p2"); !ok || id != "u1" {
		t.Errorf("the new password does not authenticate u1: %q %v", id, ok)
	}
	want := `POST /kick fixture-stats-secret-not-a-secret ["u1"]`
	if got := k.sent(); len(got) != 1 || got[0] != want {
		t.Fatalf("requests = %q, want one %q", got, want)
	}
	// The same password again changes nothing and kicks nobody.
	if err := a.AddUser(core.User{UserID: "u1", HysteriaPassword: "p2"}); err != nil {
		t.Fatal(err)
	}
	if got := k.sent(); len(got) != 1 {
		t.Fatalf("a repeated add kicked: %q", got)
	}
}

// A reissue whose kick fails fails the call, and the panel's retry of the
// same add kicks again.
func TestAFailedReissueKickIsRetriedByTheNextAdd(t *testing.T) {
	k := &kickClient{status: http.StatusInternalServerError}
	a := kickAdapter(k, true)
	if err := a.AddUser(core.User{UserID: "u1", HysteriaPassword: "p2"}); err == nil {
		t.Fatal("a failed kick on a reissue must fail the call")
	}
	if _, ok := a.LookupByPassword("p1"); ok {
		t.Error("the old password authenticates although the kick failed")
	}
	k.mu.Lock()
	k.status = http.StatusOK
	k.mu.Unlock()
	if err := a.AddUser(core.User{UserID: "u1", HysteriaPassword: "p2"}); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if got := k.sent(); len(got) != 2 {
		t.Fatalf("requests = %q, want the failed kick and its retry", got)
	}
}

// Without the traffic stats API there is nothing to kick through.
func TestNoStatsAPINoKick(t *testing.T) {
	k := &kickClient{status: http.StatusOK}
	a := kickAdapter(k, false)
	if err := a.RemoveUser("u1"); err != nil {
		t.Fatal(err)
	}
	if got := k.sent(); len(got) != 0 {
		t.Fatalf("requests without a stats API: %q", got)
	}
}
