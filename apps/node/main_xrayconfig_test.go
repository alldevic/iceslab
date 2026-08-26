package main

import (
	"reflect"
	"testing"
)

// buildXrayConfig has two outcomes and the difference between them is the whole
// deferred-key flow: with REALITY keys in the env the adapter boots configured
// and starts xray immediately; without them it comes back zeroed and false, and
// buildAdapters fills in only what it takes to accept a later ApplyInbound.
//
// Which env vars survive that second path is not obvious from either function,
// and it is the kind of thing an installer flag quietly depends on.

func TestBuildXrayConfigWithRealityKeysInTheEnv(t *testing.T) {
	t.Setenv("XRAY_REALITY_PRIVATE_KEY", "aPrivateKey")
	t.Setenv("XRAY_BINARY", "/usr/local/bin/xray")
	t.Setenv("XRAY_PORT", "8443")
	t.Setenv("XRAY_API_PORT", "9090")
	t.Setenv("XRAY_REALITY_DEST", "www.example.com:443")
	t.Setenv("XRAY_REALITY_SERVER_NAMES", " www.example.com , cdn.example.com ")
	t.Setenv("XRAY_REALITY_SHORT_IDS", "abc123,,def456")

	cfg, ok := buildXrayConfig()
	if !ok {
		t.Fatal("a private key in the env is exactly the case this returns true for")
	}
	if cfg.Inbound.ListenPort != 8443 || cfg.Inbound.ApiPort != 9090 {
		t.Errorf("ports = %d/%d, want 8443/9090", cfg.Inbound.ListenPort, cfg.Inbound.ApiPort)
	}
	if cfg.Inbound.RealityDest != "www.example.com:443" {
		t.Errorf("dest = %q", cfg.Inbound.RealityDest)
	}
	// Whitespace around a comma is what an operator's shell leaves behind, and
	// an empty slot is what a trailing comma leaves; a server name or short id
	// carrying either is one REALITY refuses at handshake time.
	if want := []string{"www.example.com", "cdn.example.com"}; !reflect.DeepEqual(cfg.Inbound.RealityServerNames, want) {
		t.Errorf("server names = %#v, want %#v", cfg.Inbound.RealityServerNames, want)
	}
	if want := []string{"abc123", "def456"}; !reflect.DeepEqual(cfg.Inbound.RealityShortIDs, want) {
		t.Errorf("short ids = %#v, want %#v (the empty slot must be dropped, not passed on)", cfg.Inbound.RealityShortIDs, want)
	}
}

func TestBuildXrayConfigWithoutRealityKeysDefersEverything(t *testing.T) {
	t.Setenv("XRAY_REALITY_PRIVATE_KEY", "")
	t.Setenv("XRAY_BINARY", "/usr/local/bin/xray")
	t.Setenv("XRAY_PORT", "8443")

	cfg, ok := buildXrayConfig()
	if ok {
		t.Fatal("no private key is the deferred flow, which must report false")
	}
	if cfg.BinaryPath != "" || cfg.Inbound.ListenPort != 0 || cfg.Inbound.RealityPrivateKey != "" {
		t.Errorf("the deferred flow must return a zero config, got %#v", cfg)
	}

	// And this is what the caller then does with it. Only three fields are put
	// back, which is why XRAY_PORT does not reach the adapter on this path: the
	// port arrives with the panel's first ApplyInbound instead.
	adapters := buildAdapters(silentLogger())
	if len(adapters) == 0 {
		t.Fatal("no adapters registered with XRAY_BINARY set")
	}
}

func TestSplitCSVDropsWhatWouldBreakAHandshake(t *testing.T) {
	// Compared by content, not by nil-ness: "" comes back nil and "   " comes
	// back as an empty slice, and nothing downstream can tell them apart —
	// xray/config.go validate() rejects both with `len(...) == 0` and the
	// renderer emits the same JSON. Asserting the difference would pin an
	// accident.
	for _, tc := range []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"   ", nil},
		{",,,", nil},
		{"one", []string{"one"}},
		{"one,two", []string{"one", "two"}},
		{" one , two ", []string{"one", "two"}},
		{"one,,two,", []string{"one", "two"}},
	} {
		got := splitCSV(tc.in)
		if len(got) != len(tc.want) {
			t.Errorf("splitCSV(%q) = %#v, want %#v", tc.in, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("splitCSV(%q) = %#v, want %#v", tc.in, got, tc.want)
				break
			}
		}
	}
}

func TestGetenvFallsBackOnEmptyNotOnUnset(t *testing.T) {
	t.Setenv("ICESLAB_TEST_KEY", "")
	if got := getenv("ICESLAB_TEST_KEY", "fallback"); got != "fallback" {
		t.Errorf("an empty value must read as absent, got %q", got)
	}
	t.Setenv("ICESLAB_TEST_KEY", "set")
	if got := getenv("ICESLAB_TEST_KEY", "fallback"); got != "set" {
		t.Errorf("getenv = %q, want the set value", got)
	}

	// getenvInt swallows an unparseable value and returns the default. That is
	// deliberate — a node must boot with a typo'd env rather than not at all —
	// but it means a mistyped port is a node listening somewhere else with
	// nothing said about it, so it is pinned rather than left to be discovered.
	t.Setenv("ICESLAB_TEST_INT", "44three")
	if got := getenvInt("ICESLAB_TEST_INT", 443); got != 443 {
		t.Errorf("getenvInt on garbage = %d, want the default 443", got)
	}
	t.Setenv("ICESLAB_TEST_INT", "1337")
	if got := getenvInt("ICESLAB_TEST_INT", 443); got != 1337 {
		t.Errorf("getenvInt = %d, want 1337", got)
	}
}
