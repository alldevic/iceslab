package server

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/payload"
)

// A push carrying two inbounds for the SAME (protocol, engine) pair is served
// by ONE adapter, and every adapter but xray stores a single inbound:
// ApplyInbound overwrites it and restarts the core. So the later inbound
// evicts the earlier, the earlier's port stops answering, and until
// 2026-08-30 the agent said nothing about it - `applied` counted both and the
// core reported itself healthy. Measured live on n-lab-1 with two mtproto
// profiles on 8443 and 9443: one mtg on 9443, the 8443 link still in the
// subscription, node `online`.
//
// The panel refuses to create such a pair now (assertNodeCoreFree), but a pair
// stored before that guard still pushes, so the machine that drops one must
// name what it dropped.

// reconcilingAdapter is a fakeAdapter that also implements
// core.InboundReconciler - i.e. it holds several inbounds, like xray.
type reconcilingAdapter struct {
	fakeAdapter
	kept []string
}

func (r *reconcilingAdapter) RetainInbounds(keep []string) error {
	r.kept = keep
	return nil
}

func newLoggingServer(t *testing.T, buf *bytes.Buffer, adapters ...core.CoreAdapter) *Server {
	t.Helper()
	srv, err := New(Config{
		Logger:   slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelWarn})),
		Payload:  &payload.Payload{NodeCertPem: "x", NodeKeyPem: "y", CACertPem: "z"},
		Adapters: adapters,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return srv
}

func push(t *testing.T, srv *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/applyInbounds", strings.NewReader(body))
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", rr.Code, rr.Body.String())
	}
	return rr
}

func TestApplyInboundsNamesTheInboundASingleInboundCoreEvicts(t *testing.T) {
	var logs bytes.Buffer
	mt := &fakeAdapter{name: "mtproto", engine: "mtproto"}
	srv := newLoggingServer(t, &logs, mt)

	rr := push(t, srv, `{"inbounds":[
		{"id":"first","name":"mt-live-1","protocol":"mtproto","port":8443,"config":{}},
		{"id":"second","name":"mt-live-2","protocol":"mtproto","port":9443,"config":{}}
	]}`)

	// The counter is the reason this needs a log at all: both were "applied".
	var resp struct{ Applied int }
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Applied != 2 {
		t.Fatalf("applied: got %d want 2 - the premise of this test is that the push looks fine", resp.Applied)
	}
	if len(mt.applied) != 2 {
		t.Fatalf("the adapter should have been handed both inbounds: %+v", mt.applied)
	}

	out := logs.String()
	if !strings.Contains(out, "holds one inbound at a time") {
		t.Fatalf("nothing above INFO said an inbound was dropped; logs=%q", out)
	}
	// Naming both halves is the point: an operator reading this has to know
	// which profile stopped listening and which one took the core.
	for _, want := range []string{"mt-live-1", "8443", "mt-live-2", "9443"} {
		if !strings.Contains(out, want) {
			t.Errorf("the warning does not name %q; logs=%q", want, out)
		}
	}
}

func TestApplyInboundsStaysQuietForOneInboundPerCore(t *testing.T) {
	// The control. A warning that fired on every push would be worth nothing,
	// and would pass the case above just as well.
	var logs bytes.Buffer
	mt := &fakeAdapter{name: "mtproto", engine: "mtproto"}
	hy := &fakeAdapter{name: "hysteria", engine: "hysteria"}
	srv := newLoggingServer(t, &logs, mt, hy)

	push(t, srv, `{"inbounds":[
		{"id":"a","name":"mt","protocol":"mtproto","port":8443,"config":{}},
		{"id":"b","name":"hy","protocol":"hysteria","port":9443,"config":{}}
	]}`)

	if strings.Contains(logs.String(), "holds one inbound at a time") {
		t.Errorf("two DIFFERENT cores were reported as evicting each other; logs=%q", logs.String())
	}
}

func TestApplyInboundsStaysQuietForAnAdapterThatHoldsSeveral(t *testing.T) {
	// xray keys its inbounds by binding id and reconciles deletions, so two of
	// them are not an eviction. Asking the interface rather than the protocol
	// name is what keeps this true when another adapter learns the same trick.
	var logs bytes.Buffer
	xr := &reconcilingAdapter{fakeAdapter: fakeAdapter{name: "xray", engine: "xray"}}
	srv := newLoggingServer(t, &logs, xr)

	push(t, srv, `{"inbounds":[
		{"id":"a","name":"vless-1","protocol":"xray","port":443,"config":{}},
		{"id":"b","name":"vless-2","protocol":"xray","port":8443,"config":{}}
	]}`)

	if strings.Contains(logs.String(), "holds one inbound at a time") {
		t.Errorf("a multi-inbound adapter was reported as evicting; logs=%q", logs.String())
	}
	if len(xr.kept) != 2 {
		t.Errorf("RetainInbounds should have been handed both ids, got %v", xr.kept)
	}
}

func TestApplyInboundsKeysOnTheProtocolEngineTakenTogether(t *testing.T) {
	// Two inbounds, one protocol, two engines: the node dispatches on the PAIR,
	// so these land on two different adapter objects and neither evicts the
	// other. A check keyed on the protocol alone reports an eviction that did
	// not happen - and it passed every other case in this file, because none of
	// them pushes one protocol under two engines.
	var logs bytes.Buffer
	native := &fakeAdapter{name: "xray", engine: "xray"}
	sb := &fakeAdapter{name: "xray", engine: "singbox"}
	srv := newLoggingServer(t, &logs, native, sb)

	push(t, srv, `{"inbounds":[
		{"id":"a","name":"vless-native","protocol":"xray","port":443,"config":{}},
		{"id":"b","name":"vless-singbox","protocol":"xray","port":8443,"engine":"singbox","config":{}}
	]}`)

	if len(native.applied) != 1 || len(sb.applied) != 1 {
		t.Fatalf("each adapter should have taken its own inbound: native=%+v singbox=%+v",
			native.applied, sb.applied)
	}
	if strings.Contains(logs.String(), "holds one inbound at a time") {
		t.Errorf("two different cores were reported as evicting each other; logs=%q", logs.String())
	}
}
