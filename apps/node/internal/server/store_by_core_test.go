package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// blockCore takes a policy or resolver unless it carries `refuse`, and
// remembers the last ones it was given.
type blockCore struct {
	fakeCore
	refuse        string
	policy, dns   string
	policyN, dnsN int
}

func (b *blockCore) ApplyPolicy(p json.RawMessage) error {
	b.policyN++
	if b.refuse != "" && strings.Contains(string(p), b.refuse) {
		return errors.New("an action this core cannot render")
	}
	b.policy = string(p)
	return nil
}

func (b *blockCore) ApplyDns(d json.RawMessage) error {
	b.dnsN++
	if b.refuse != "" && strings.Contains(string(d), b.refuse) {
		return errors.New("a resolver this core cannot render")
	}
	b.dns = string(d)
	return nil
}

func twoBlockCores() (*blockCore, *blockCore) {
	return &blockCore{fakeCore: fakeCore{name: "xray", engine: "xray", running: true}},
		&blockCore{fakeCore: fakeCore{name: "tuic", engine: "singbox", running: true}, refuse: "only-xray"}
}

// A-185: xray took the new policy and resolver, sing-box refused them and
// kept the old ones. After a restart each is back on what it ran: xray on the
// new, sing-box on the old. One flag for all put both on the old.
func TestARestartGivesEachCoreThePolicyAndResolverItTook(t *testing.T) {
	store := filepath.Join(t.TempDir(), "inbounds.json")
	xray, sb := twoBlockCores()
	s := serverWithStore(t, store, xray, sb)

	const inbound = `"inbounds":[{"id":"i1","name":"one","protocol":"xray","port":0,"config":{}}]`
	if code := pushOver(t, s, `{`+inbound+`,"policy":{"v":"old"},"dns":{"v":"old"}}`); code != http.StatusOK {
		t.Fatalf("first push answered %d", code)
	}
	if code := pushOver(t, s, `{`+inbound+`,"policy":{"v":"new-only-xray"},"dns":{"v":"new-only-xray"}}`); code != http.StatusInternalServerError {
		t.Fatalf("a push one core refused answered %d, want 500", code)
	}
	if !strings.Contains(xray.policy, "new") || !strings.Contains(sb.policy, "old") {
		t.Fatalf("before the restart: xray %s, sing-box %s", xray.policy, sb.policy)
	}

	xray2, sb2 := twoBlockCores()
	restarted := serverWithStore(t, store, xray2, sb2)
	restarted.restoreFromStore(context.Background())
	if !strings.Contains(xray2.policy, "new-only-xray") || !strings.Contains(xray2.dns, "new-only-xray") {
		t.Errorf("xray came back on policy %s, dns %s; it had taken the new ones", xray2.policy, xray2.dns)
	}
	if !strings.Contains(sb2.policy, "old") || !strings.Contains(sb2.dns, "old") {
		t.Errorf("sing-box came back on policy %s, dns %s; it ran the old ones", sb2.policy, sb2.dns)
	}

	// The next push both take clears the exception.
	if code := pushOver(t, restarted, `{`+inbound+`,"policy":{"v":"newer"},"dns":{"v":"newer"}}`); code != http.StatusOK {
		t.Fatalf("a push both took answered %d", code)
	}
	st, err := readStored(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.PolicyByCore) != 0 || len(st.DnsByCore) != 0 {
		t.Errorf("exceptions left after a push every core took: %v %v", st.PolicyByCore, st.DnsByCore)
	}
}

// A core that refused its first policy ran none, and comes back on none.
func TestACoreThatNeverHadAPolicyComesBackOnNone(t *testing.T) {
	store := filepath.Join(t.TempDir(), "inbounds.json")
	xray, sb := twoBlockCores()
	s := serverWithStore(t, store, xray, sb)
	const inbound = `"inbounds":[{"id":"i1","name":"one","protocol":"xray","port":0,"config":{}}]`
	pushOver(t, s, `{`+inbound+`,"policy":{"v":"first-only-xray"}}`)

	xray2, sb2 := twoBlockCores()
	serverWithStore(t, store, xray2, sb2).restoreFromStore(context.Background())
	if !strings.Contains(xray2.policy, "first-only-xray") {
		t.Errorf("xray came back on %q", xray2.policy)
	}
	if sb2.policyN != 1 || sb2.policy != "" {
		t.Errorf("sing-box came back on %q (%d calls), want none", sb2.policy, sb2.policyN)
	}
}
