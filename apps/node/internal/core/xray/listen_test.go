package xray

import (
	"strings"
	"testing"
)

// The goldens are the base's: pin the host as one without a dual-stack `::`.
func init() { listenAddr = func() string { return "0.0.0.0" } }

func TestListenHostDefaultFollowsTheHost(t *testing.T) {
	defer func(f func() string) { listenAddr = f }(listenAddr)
	for _, c := range []struct{ host, pinned, want string }{
		{"", "::", "::"},
		{"", "0.0.0.0", "0.0.0.0"},
		{"10.0.0.5", "::", "10.0.0.5"}, // an explicit address is the operator's
		{"127.0.0.1", "::", "127.0.0.1"},
	} {
		listenAddr = func() string { return c.pinned }
		in := InboundConfig{ListenHost: c.host}
		if got := in.withDefaults().ListenHost; got != c.want {
			t.Errorf("host %q on %q: got %q, want %q", c.host, c.pinned, got, c.want)
		}
	}
}

func TestRenderedInboundListensOnTheChosenAddress(t *testing.T) {
	defer func(f func() string) { listenAddr = f }(listenAddr)
	listenAddr = func() string { return "::" }
	in := InboundConfig{RealityDest: "x.com:443", RealityServerNames: []string{"x.com"}, RealityPrivateKey: "k", RealityShortIDs: []string{"s"}}
	blob, err := renderConfig(in, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(blob), `"listen": "::"`) {
		t.Errorf("no \"::\" listener in the render:\n%s", blob)
	}
}
