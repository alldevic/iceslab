package server

import (
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// reportingCore says whether it counts per user and why it is down
// (core.UserCounter, core.FaultReporter).
type reportingCore struct {
	provisionableCore
	counts bool
	fault  string
}

func (r *reportingCore) CountsUsers() bool { return r.counts }
func (r *reportingCore) Fault() string     { return r.fault }

func coreRow(t *testing.T, got dto.HealthcheckResponse, name string) dto.CoreStatus {
	t.Helper()
	for _, c := range got.Cores {
		if string(c.Name) == name {
			return c
		}
	}
	t.Fatalf("no row for %q", name)
	return dto.CoreStatus{}
}

func TestHealthCarriesCountsUsersAndTheFaultOfADownCore(t *testing.T) {
	got := health(t,
		&reportingCore{provisionableCore{fakeCore{name: "xray", running: true}, true}, true, ""},
		&reportingCore{provisionableCore{fakeCore{name: "naive", running: false}, true}, false, "exit status 1: bind: address already in use"},
	)
	x := coreRow(t, got, "xray")
	if x.CountsUsers == nil || !*x.CountsUsers {
		t.Errorf("xray countsUsers = %v, want true", x.CountsUsers)
	}
	if x.Error != nil {
		t.Errorf("a running core reports an error: %q", *x.Error)
	}
	n := coreRow(t, got, "naive")
	if n.CountsUsers == nil || *n.CountsUsers {
		t.Errorf("naive countsUsers = %v, want false, said and not left out", n.CountsUsers)
	}
	if n.Error == nil || !strings.Contains(*n.Error, "address already in use") {
		t.Errorf("naive error = %v, want the process's own words", n.Error)
	}
}

// Down by design is not a fault: an idle core says nothing, whatever its
// adapter would say, and so does a core that is down without a reason.
func TestHealthSaysNoErrorForAnIdleCoreOrAnEmptyReason(t *testing.T) {
	body := healthBody(t,
		&reportingCore{provisionableCore{fakeCore{name: "tuic", running: false}, false}, true, "stale words"},
		&reportingCore{provisionableCore{fakeCore{name: "hysteria", running: false}, true}, true, ""},
	)
	if strings.Contains(body, `"error"`) {
		t.Errorf("an idle core or an empty reason must leave the key out: %s", body)
	}
}

// An adapter that does not implement UserCounter leaves the key out: unknown,
// not false.
func TestHealthLeavesCountsUsersOutWhenTheCoreDoesNotSay(t *testing.T) {
	body := healthBody(t, &provisionableCore{fakeCore{name: "xray", running: true}, true})
	if strings.Contains(body, `"countsUsers"`) {
		t.Errorf("countsUsers present for an adapter that does not say: %s", body)
	}
}
