package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// `internal/core/adapter.go` is 333 lines and not one of them executes: it is
// the CoreAdapter interface plus five OPTIONAL ones. Optional is the whole
// point and the whole risk - an adapter that does not implement one is not a
// compile error and not a runtime error, it is silence. What that silence looks
// like on the wire is decided here, in the handlers that type-assert.
//
// Nothing asserted any of it before: the server tests never mentioned Version,
// Restarts, LastError or /generateKeys.

// bareCore implements CoreAdapter and none of the optional interfaces. It is
// the adapter a contributor writes on day one.
type bareCore struct {
	name    string
	running bool
}

func (b *bareCore) Name() string                            { return b.name }
func (b *bareCore) Engine() string                          { return b.name }
func (b *bareCore) Start(context.Context) error             { return nil }
func (b *bareCore) Stop(context.Context) error              { return nil }
func (b *bareCore) AddUser(core.User) error                 { return nil }
func (b *bareCore) RemoveUser(string) error                 { return nil }
func (b *bareCore) GetStats() (*core.Stats, error)          { return &core.Stats{}, nil }
func (b *bareCore) Healthy() bool                           { return b.running }
func (b *bareCore) ApplyInbound(int, json.RawMessage) error { return nil }

// reportingCore implements every optional interface a supervising core would.
type reportingCore struct {
	bareCore
	version string
	failure string
	stats   core.RestartStats
}

func (r *reportingCore) CoreVersion() string             { return r.version }
func (r *reportingCore) LastFailure() string             { return r.failure }
func (r *reportingCore) RestartStats() core.RestartStats { return r.stats }

type keygenCore struct {
	bareCore
	raw string
	err error
	got []string
}

func (k *keygenCore) GenerateKeys(kind string) (string, error) {
	k.got = append(k.got, kind)
	return k.raw, k.err
}

type reconcilingCore struct {
	bareCore
	kept  [][]string
	calls int
}

func (r *reconcilingCore) RetainInbounds(keep []string) error {
	r.calls++
	r.kept = append(r.kept, keep)
	return nil
}

// healthJSON returns /healthz as a raw map, because the question here is which
// KEYS reach the panel. Decoding into the DTO would turn "absent" into a zero
// value and erase the distinction the whole design rests on.
func healthJSON(t *testing.T, adapters ...core.CoreAdapter) map[string]any {
	t.Helper()
	srv := newServerWith(t, adapters...)
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("/healthz: got %d, body=%s", rr.Code, rr.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode /healthz: %v (body %s)", err, rr.Body.String())
	}
	return out
}

func coreEntry(t *testing.T, health map[string]any, name string) map[string]any {
	t.Helper()
	cores, _ := health["cores"].([]any)
	for _, c := range cores {
		m, _ := c.(map[string]any)
		if m["name"] == name {
			return m
		}
	}
	t.Fatalf("core %q missing from /healthz: %v", name, health)
	return nil
}

// The DTO is explicit that absent must not read as zero: a panel that took a
// missing `restarts` for "0 restarts" would overwrite a real tally it had
// stored from a previous, better-informed agent. So an adapter that cannot
// report must send nothing at all, not an empty object of zeroes.
func TestHealthSendsNothingForWhatAnAdapterCannotReport(t *testing.T) {
	got := coreEntry(t, healthJSON(t, &bareCore{name: "hysteria", running: false}), "hysteria")

	for _, key := range []string{"restarts", "version", "lastError", "provisioned"} {
		if _, present := got[key]; present {
			t.Errorf("%q is present for an adapter that implements no optional interface (%v); "+
				"absent and zero are different answers and the panel reads them differently", key, got[key])
		}
	}
	// The mandatory half must still be there, or the test above would pass on
	// an empty response.
	if got["running"] != false {
		t.Errorf("running = %v, want false", got["running"])
	}
}

func TestHealthReportsWhatAnAdapterCan(t *testing.T) {
	since := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	last := time.Date(2026, 8, 26, 4, 30, 0, 0, time.UTC)
	rc := &reportingCore{
		bareCore: bareCore{name: "xray", running: true},
		version:  "26.3.27",
		stats: core.RestartStats{
			Crash: 2, Memory: 3,
			LastAt: last, LastReason: "memory", SinceAt: since,
			MemoryLimitBytes: 512 << 20, RSSBytes: 400 << 20,
		},
	}
	got := coreEntry(t, healthJSON(t, rc), "xray")

	if got["version"] != "26.3.27" {
		t.Errorf("version = %v, want the binary version the adapter reports", got["version"])
	}
	restarts, ok := got["restarts"].(map[string]any)
	if !ok {
		t.Fatalf("restarts missing for an adapter that reports them: %v", got)
	}
	// Total is sent explicitly rather than derived, so it is worth checking it
	// still equals the breakdown it claims to sum.
	if restarts["total"] != float64(5) || restarts["crash"] != float64(2) || restarts["memory"] != float64(3) {
		t.Errorf("restarts = %v, want total 5 = crash 2 + memory 3", restarts)
	}
	if restarts["core"] != "xray" {
		t.Errorf("restarts.core = %v, want the core these numbers belong to", restarts["core"])
	}
	// RFC3339 in UTC: "3 restarts" cannot be dated without it, and the panel
	// parses the string rather than guessing a layout.
	if restarts["lastAt"] != "2026-08-26T04:30:00Z" {
		t.Errorf("restarts.lastAt = %v, want RFC3339 UTC", restarts["lastAt"])
	}
	if restarts["sinceAt"] != "2026-08-01T10:00:00Z" {
		t.Errorf("restarts.sinceAt = %v, want RFC3339 UTC", restarts["sinceAt"])
	}
	if restarts["memoryLimitBytes"] != float64(512<<20) || restarts["rssBytes"] != float64(400<<20) {
		t.Errorf("restarts = %v, want the armed ceiling and the latest sample", restarts)
	}
}

// A tally that has never moved must not carry timestamps: a zero time formatted
// as RFC3339 reads as "restarted in year 1", which is not what happened.
func TestHealthOmitsRestartTimestampsThatNeverHappened(t *testing.T) {
	rc := &reportingCore{bareCore: bareCore{name: "xray", running: true}}
	got := coreEntry(t, healthJSON(t, rc), "xray")
	restarts, ok := got["restarts"].(map[string]any)
	if !ok {
		t.Fatalf("restarts missing: %v", got)
	}
	if _, present := restarts["lastAt"]; present {
		t.Errorf("lastAt = %v on a core that never restarted", restarts["lastAt"])
	}
	if _, present := restarts["sinceAt"]; present {
		t.Errorf("sinceAt = %v was never set by the adapter", restarts["sinceAt"])
	}
}

// The reason a core is down is only a reason while it is down. On a live core
// the same field is ordinary chatter, and a status message quoting it would
// show the operator a fault that is not there.
func TestFailureReasonIsSentOnlyForACoreThatIsDown(t *testing.T) {
	down := &reportingCore{
		bareCore: bareCore{name: "xray", running: false},
		failure:  "failed to listen on 443: address already in use",
	}
	got := coreEntry(t, healthJSON(t, down), "xray")
	if got["lastError"] != down.failure {
		t.Errorf("lastError = %v, want the core's own last line: it is the only place "+
			"the reason exists outside the node's journal", got["lastError"])
	}

	up := &reportingCore{
		bareCore: bareCore{name: "xray", running: true},
		failure:  "2026/08/26 04:30:00 [Info] transport/internet/tcp: listening",
	}
	got = coreEntry(t, healthJSON(t, up), "xray")
	if _, present := got["lastError"]; present {
		t.Errorf("lastError = %v on a RUNNING core: its last line is chatter, not a fault",
			got["lastError"])
	}
}

func generateKeys(t *testing.T, kind string, adapters ...core.CoreAdapter) *httptest.ResponseRecorder {
	t.Helper()
	srv := newServerWith(t, adapters...)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/generateKeys",
		strings.NewReader(`{"kind":"`+kind+`"}`))
	srv.routes().ServeHTTP(rr, req)
	return rr
}

// A node whose cores cannot mint keys must say so. The panel offers the button
// per node; a hang or a 500 would read as "the node is broken" instead of
// "this node has no core that does this".
func TestGenerateKeysWithoutACapableCoreIs404(t *testing.T) {
	rr := generateKeys(t, "mldsa65", &bareCore{name: "hysteria", running: true})
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 on a node where no adapter implements KeyGenerator; body=%s",
			rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "KEYGEN_UNSUPPORTED") {
		t.Errorf("body = %s, want the KEYGEN_UNSUPPORTED code", rr.Body.String())
	}
}

// The dispatcher walks past adapters that cannot generate and asks the one that
// can. Getting this backwards would make the capability invisible on every node
// that runs more than one core.
func TestGenerateKeysSkipsPastCoresThatCannot(t *testing.T) {
	kg := &keygenCore{bareCore: bareCore{name: "xray", running: true}, raw: "Seed: abc\nVerify: def\n"}
	rr := generateKeys(t, "mldsa65", &bareCore{name: "hysteria", running: true}, kg)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	var out struct {
		OK   bool   `json:"ok"`
		Kind string `json:"kind"`
		Raw  string `json:"raw"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rr.Body.String())
	}
	// Verbatim: what the panel wants out of this output moves with the core
	// version, so the node must not tidy it.
	if out.Raw != kg.raw {
		t.Errorf("raw = %q, want the subcommand's stdout untouched (%q)", out.Raw, kg.raw)
	}
	if out.Kind != "mldsa65" {
		t.Errorf("kind = %q, want the kind that was asked for", out.Kind)
	}
	if len(kg.got) != 1 || kg.got[0] != "mldsa65" {
		t.Errorf("adapter saw kinds %v, want exactly [mldsa65]", kg.got)
	}
}

// A capable core that refuses is a different answer from no capable core: the
// operator has to know whether to pick another node or fix this one.
func TestGenerateKeysReportsTheCapableCoresFailure(t *testing.T) {
	kg := &keygenCore{
		bareCore: bareCore{name: "xray", running: true},
		err:      errors.New("unknown kind: banana"),
	}
	rr := generateKeys(t, "banana", kg)
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 when the core that can generate refused; body=%s",
			rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "unknown kind: banana") {
		t.Errorf("body = %s, want the core's own refusal in it", rr.Body.String())
	}
}

func applyInbounds(t *testing.T, body string, adapters ...core.CoreAdapter) {
	t.Helper()
	srv := newServerWith(t, adapters...)
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/applyInbounds", strings.NewReader(body)))
	if rr.Code != http.StatusOK {
		t.Fatalf("/applyInbounds: got %d, body=%s", rr.Code, rr.Body.String())
	}
}

// The push is dispatched one inbound at a time, so an adapter holding several
// never learns that one was DELETED - found in the field the day after
// multi-inbound landed, with a removed inbound still listening. The reconcile
// pass hands the full set to adapters that can take it, and must not care that
// other adapters cannot.
func TestReconcileReachesOnlyTheAdaptersThatImplementIt(t *testing.T) {
	rec := &reconcilingCore{bareCore: bareCore{name: "xray", running: true}}
	plain := &bareCore{name: "hysteria", running: true}

	applyInbounds(t,
		`{"inbounds":[{"id":"i1","name":"a","protocol":"xray","port":0,"config":{}},`+
			`{"id":"i2","name":"b","protocol":"xray","port":0,"config":{}}]}`,
		rec, plain)

	if rec.calls != 1 {
		t.Fatalf("RetainInbounds called %d times, want once per push", rec.calls)
	}
	if len(rec.kept[0]) != 2 || rec.kept[0][0] != "i1" || rec.kept[0][1] != "i2" {
		t.Errorf("keep set = %v, want both ids of the push that just landed", rec.kept[0])
	}
}

// The empty set is the case that matters: it means the operator removed the
// last inbound of this kind. Skipping the call there - the tempting
// optimisation - leaves the deleted inbound serving forever.
func TestReconcileStillRunsWhenNothingIsLeft(t *testing.T) {
	rec := &reconcilingCore{bareCore: bareCore{name: "xray", running: true}}

	applyInbounds(t, `{"inbounds":[]}`, rec)

	if rec.calls != 1 {
		t.Fatalf("RetainInbounds called %d times on an empty push, want once: "+
			"an empty set is how the last inbound is removed", rec.calls)
	}
	if len(rec.kept[0]) != 0 {
		t.Errorf("keep set = %v, want empty", rec.kept[0])
	}
}
