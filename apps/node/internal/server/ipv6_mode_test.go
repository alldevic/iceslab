package server

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// modeCore records the IPv6 mode in force at the moment it is handed a block,
// which is when a real core draws its config.
type modeCore struct {
	fakeCore
	modes []string
}

func (m *modeCore) ApplyDns(json.RawMessage) error {
	m.modes = append(m.modes, core.IPv6ModeNow())
	return nil
}

const modeInbound = `"inbounds":[{"id":"i1","name":"one","protocol":"xray","port":0,"config":{}}]`

func newModeCore() *modeCore {
	return &modeCore{fakeCore: fakeCore{name: "xray", engine: "xray", running: true}}
}

// 18.6: the mode of a push is in force before the cores are handed it; a push
// without the field (an older panel, or a node on auto) puts it back to auto.
func TestThePushedIPv6ModeIsInForceWhenTheCoresDraw(t *testing.T) {
	defer core.SetIPv6Mode(core.IPv6ModeAuto)
	c := newModeCore()
	s := serverWithStore(t, filepath.Join(t.TempDir(), "inbounds.json"), c)
	for _, push := range []struct{ body, want string }{
		{`{` + modeInbound + `,"dns":{"v":1},"ipv6Mode":"off"}`, "off"},
		{`{` + modeInbound + `,"dns":{"v":2},"ipv6Mode":"on"}`, "on"},
		{`{` + modeInbound + `,"dns":{"v":3}}`, "auto"},
		{`{` + modeInbound + `,"dns":{"v":4},"ipv6Mode":"sideways"}`, "auto"},
	} {
		if code := pushOver(t, s, push.body); code != http.StatusOK {
			t.Fatalf("push %s answered %d", push.body, code)
		}
		if got := c.modes[len(c.modes)-1]; got != push.want {
			t.Errorf("push %s: cores drew under %q, want %q", push.body, got, push.want)
		}
	}
}

// The mode is part of the stored request, so a restarted agent draws under it
// before the panel's first poll, and an agent that never heard of the field
// (a store without it) restores as auto.
func TestTheIPv6ModeSurvivesARestart(t *testing.T) {
	defer core.SetIPv6Mode(core.IPv6ModeAuto)
	store := filepath.Join(t.TempDir(), "inbounds.json")
	c := newModeCore()
	s := serverWithStore(t, store, c)
	if code := pushOver(t, s, `{`+modeInbound+`,"dns":{"v":1},"ipv6Mode":"off"}`); code != http.StatusOK {
		t.Fatalf("push answered %d", code)
	}
	st, err := readStored(store)
	if err != nil || st.Ipv6Mode != "off" {
		t.Fatalf("stored mode %q (%v), want off", st.Ipv6Mode, err)
	}

	core.SetIPv6Mode(core.IPv6ModeAuto) // a new process starts on auto
	c2 := newModeCore()
	serverWithStore(t, store, c2).restoreFromStore(context.Background())
	if len(c2.modes) != 1 || c2.modes[0] != "off" || core.IPv6ModeNow() != "off" {
		t.Errorf("restored under %v (now %q), want off", c2.modes, core.IPv6ModeNow())
	}

	// A store written before the field: auto.
	if code := pushOver(t, s, `{`+modeInbound+`,"dns":{"v":2}}`); code != http.StatusOK {
		t.Fatal("push without the mode failed")
	}
	core.SetIPv6Mode("on")
	c3 := newModeCore()
	serverWithStore(t, store, c3).restoreFromStore(context.Background())
	if len(c3.modes) != 1 || c3.modes[0] != "auto" {
		t.Errorf("a store without the mode restored under %v, want auto", c3.modes)
	}
}

// A request without the field decodes to auto, and one with it is read: the
// agent side of "old agent takes a request with the field, new agent takes one
// without".
func TestTheRequestCarriesTheModeOnlyWhenItIsNotAuto(t *testing.T) {
	var req dto.ApplyInboundsRequest
	if err := json.Unmarshal([]byte(`{"inbounds":[]}`), &req); err != nil || core.NormalizeIPv6Mode(req.Ipv6Mode) != "auto" {
		t.Errorf("absent field: %q (%v)", req.Ipv6Mode, err)
	}
	if err := json.Unmarshal([]byte(`{"inbounds":[],"ipv6Mode":"off"}`), &req); err != nil || req.Ipv6Mode != "off" {
		t.Errorf("present field: %q (%v)", req.Ipv6Mode, err)
	}
	body, _ := json.Marshal(dto.ApplyInboundsRequest{})
	if string(body) != `{"inbounds":null}` {
		t.Errorf("an empty request gained bytes: %s", body)
	}
}
