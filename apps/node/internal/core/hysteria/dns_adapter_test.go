package hysteria

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func dnsJSON(s string) json.RawMessage { return json.RawMessage(s) }

const generalDNS = `{"servers":[{"address":"1.1.1.1"}]}`
const domainDNS = `{"servers":[{"address":"10.0.0.2","domains":["corp.example"]}]}`

func TestApplyDns_WritesTheSectionAndRestartsOnce(t *testing.T) {
	runner := &recordingRunner{}
	a, cfgPath := newApplyInboundAdapter(t, runner)
	if err := a.ApplyInbound(443, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	before := len(runner.snapshot())
	if err := a.ApplyDns(dnsJSON(generalDNS)); err != nil {
		t.Fatal(err)
	}
	// The same setting again: no restart.
	if err := a.ApplyDns(dnsJSON(generalDNS)); err != nil {
		t.Fatal(err)
	}
	if got := len(runner.snapshot()) - before; got != 1 {
		t.Errorf("restarts = %d, want 1", got)
	}
	blob, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(blob), "resolver:\n  type: udp\n  udp:\n    addr: \"1.1.1.1:53\"\n") {
		t.Errorf("no resolver in the config:\n%s", blob)
	}
	if !a.ExecutesDns() {
		t.Error("a general server is executed")
	}
}

func TestApplyDns_NilTakesItAway(t *testing.T) {
	runner := &recordingRunner{}
	a, cfgPath := newApplyInboundAdapter(t, runner)
	_ = a.ApplyInbound(443, json.RawMessage(`{}`))
	_ = a.ApplyDns(dnsJSON(generalDNS))
	if err := a.ApplyDns(nil); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(cfgPath)
	if strings.Contains(string(blob), "resolver:") {
		t.Errorf("the resolver survived its removal:\n%s", blob)
	}
}

// A setting that draws no section (domain rules only) changes no file, so it
// restarts nothing, and it is reported as not executed.
func TestApplyDns_DomainRulesAreNotExecutedAndRestartNothing(t *testing.T) {
	runner := &recordingRunner{}
	a, _ := newApplyInboundAdapter(t, runner)
	_ = a.ApplyInbound(443, json.RawMessage(`{}`))
	before := len(runner.snapshot())
	if err := a.ApplyDns(dnsJSON(domainDNS)); err != nil {
		t.Fatal(err)
	}
	if got := len(runner.snapshot()) - before; got != 0 {
		t.Errorf("restarts = %d, want 0: the file is the same", got)
	}
	if a.ExecutesDns() {
		t.Error("domain rules reported as executed")
	}
	// Taking it away is a state change that restarts nothing either, and
	// leaves the node reporting "nothing left undone".
	_ = a.ApplyDns(nil)
	if !a.ExecutesDns() {
		t.Error("no setting must not read as an unexecuted one")
	}
}

func TestApplyDns_EmptyServersIsRefused(t *testing.T) {
	a, _ := newApplyInboundAdapter(t, &recordingRunner{})
	if err := a.ApplyDns(dnsJSON(`{"servers":[]}`)); err == nil {
		t.Error("a dns section with no servers was taken")
	}
}

// ApplyDns runs before the inbounds of the same push: remembered, written by
// the render that follows.
func TestApplyDns_BeforeAnyInboundIsRememberedNotWritten(t *testing.T) {
	runner := &recordingRunner{}
	a, cfgPath := newApplyInboundAdapter(t, runner)
	if err := a.ApplyDns(dnsJSON(generalDNS)); err != nil {
		t.Fatal(err)
	}
	if len(runner.snapshot()) != 0 {
		t.Error("restarted with nothing to serve")
	}
	if err := a.ApplyInbound(443, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(blob), "addr: \"1.1.1.1:53\"") {
		t.Errorf("the remembered resolver was not rendered:\n%s", blob)
	}
}
