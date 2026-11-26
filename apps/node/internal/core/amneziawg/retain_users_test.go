package amneziawg

import (
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// Milestone 9.7: peers of users the panel no longer knows are dropped.

func twoUsersAdapter(t *testing.T) (*Adapter, string) {
	t.Helper()
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "keep", AmneziaWGPeers: twoDevices()[:1]}); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "orphan", AmneziaWGPeers: twoDevices()[1:]}); err != nil {
		t.Fatal(err)
	}
	return a, cfgPath
}

func TestRetainUsers_TheExtraPeerGoesTheNeededStays(t *testing.T) {
	a, cfgPath := twoUsersAdapter(t)
	n, err := a.RetainUsers([]string{"keep"})
	if err != nil || n != 1 {
		t.Fatalf("RetainUsers: n=%d err=%v, want 1", n, err)
	}
	conf := readConf(t, cfgPath)
	if strings.Contains(conf, testWGPubKeyB) || !strings.Contains(conf, testWGPubKeyA) {
		t.Fatalf("wrong peers left:\n%s", conf)
	}
	state := readConf(t, a.statePath())
	if strings.Contains(state, testWGPubKeyB) || !strings.Contains(state, testWGPubKeyA) {
		t.Fatalf("state file not updated:\n%s", state)
	}
	if n, _ := a.RetainUsers([]string{"keep", "unknown"}); n != 0 {
		t.Fatalf("a second pass removed %d", n)
	}
}

func TestRetainUsers_EmptySetRemovesEveryone(t *testing.T) {
	a, cfgPath := twoUsersAdapter(t)
	n, err := a.RetainUsers(nil)
	if err != nil || n != 2 {
		t.Fatalf("n=%d err=%v, want 2", n, err)
	}
	if conf := readConf(t, cfgPath); strings.Contains(conf, "[Peer]") {
		t.Fatalf("peers left:\n%s", conf)
	}
}

func TestRetainUsers_AllDevicesOfAUserGoTogether(t *testing.T) {
	a, cfgPath := devicesAdapter(t)
	if err := a.AddUser(core.User{UserID: "multi", AmneziaWGPeers: twoDevices()}); err != nil {
		t.Fatal(err)
	}
	n, err := a.RetainUsers([]string{"other"})
	if err != nil || n != 1 {
		t.Fatalf("n=%d err=%v, want one user", n, err)
	}
	if conf := readConf(t, cfgPath); strings.Contains(conf, "[Peer]") {
		t.Fatalf("a device stayed behind:\n%s", conf)
	}
}
