package singbox

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const dnsOne = `{"servers":[{"address":"10.0.0.53","domains":["corp.test"]}]}`

// Without a setting the config is the one the base drew, to the byte; taking
// the setting off puts it back.
func TestWithoutAResolverTheConfigIsTheBaseOne(t *testing.T) {
	a, starts := countingAdapter(t)
	cfgPath := filepath.Join(filepath.Dir(starts), "config.json")
	base, _ := os.ReadFile(cfgPath)
	if strings.Contains(string(base), `"dns"`) || strings.Contains(string(base), `"route"`) {
		t.Fatalf("the base config carries a resolver: %s", base)
	}
	if err := a.ApplyDns(nil); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyDns(json.RawMessage("null")); err != nil {
		t.Fatal(err)
	}
	if n := startCount(starts); n != 1 {
		t.Fatalf("an absent resolver on a node with none restarted the core: %d starts", n)
	}
	if err := a.ApplyDns(json.RawMessage(dnsOne)); err != nil {
		t.Fatal(err)
	}
	waitStarts(t, starts, 2)
	with, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(with), `"node-dns-1"`) {
		t.Fatalf("the setting did not reach the config: %s", with)
	}
	if err := a.ApplyDns(nil); err != nil {
		t.Fatal(err)
	}
	waitStarts(t, starts, 3)
	after, _ := os.ReadFile(cfgPath)
	if string(after) != string(base) {
		t.Fatalf("taking the resolver off did not bring the base config back:\n%s\n%s", after, base)
	}
}

func TestTheSameResolverTwiceDoesNotRestartTheCoreAndAChangeDoes(t *testing.T) {
	a, starts := countingAdapter(t)
	if err := a.ApplyDns(json.RawMessage(dnsOne)); err != nil {
		t.Fatal(err)
	}
	waitStarts(t, starts, 2)
	// The same value, spelt differently in whitespace and key order.
	if err := a.ApplyDns(json.RawMessage(`{ "servers": [ {"domains":["corp.test"], "address":"10.0.0.53"} ] }`)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if n := startCount(starts); n != 2 {
		t.Fatalf("the same resolver restarted the core: %d starts", n)
	}
	if err := a.ApplyDns(json.RawMessage(`{"servers":[{"address":"10.0.0.54","domains":["corp.test"]}]}`)); err != nil {
		t.Fatal(err)
	}
	waitStarts(t, starts, 3)
}

func TestAResolverTheEngineRefusesIsNotKept(t *testing.T) {
	a, starts := countingAdapter(t)
	err := a.ApplyDns(json.RawMessage(`{"servers":[{"address":"https://refuse-me.example/dns-query"}]}`))
	if err == nil || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("expected the engine's refusal, got %v", err)
	}
	a.mu.Lock()
	kept := a.dns
	a.mu.Unlock()
	if kept != nil || startCount(starts) != 1 {
		t.Fatalf("a refused resolver was kept (%v) or restarted the core (%d)", kept, startCount(starts))
	}
}

func TestASectionWithNoServersIsRefusedBeforeAnything(t *testing.T) {
	a, starts := countingAdapter(t)
	if err := a.ApplyDns(json.RawMessage(`{"servers":[]}`)); err == nil {
		t.Fatal("an empty section was taken")
	}
	if startCount(starts) != 1 {
		t.Fatal("restarted")
	}
}
