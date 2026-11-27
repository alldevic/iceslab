package shadowsocks

import "testing"

// The goldens are the base's: pin the host as one without a dual-stack `::`.
func init() { listenAddr = func() string { return "0.0.0.0" } }

func TestListenHostDefaultFollowsTheHost(t *testing.T) {
	defer func(f func() string) { listenAddr = f }(listenAddr)
	for _, c := range []struct{ host, pinned, want string }{
		{"", "::", "::"},
		{"", "0.0.0.0", "0.0.0.0"},
		{"10.0.0.5", "::", "10.0.0.5"},
	} {
		listenAddr = func() string { return c.pinned }
		in := InboundConfig{ListenHost: c.host}
		if got := in.withDefaults().ListenHost; got != c.want {
			t.Errorf("host %q on %q: got %q, want %q", c.host, c.pinned, got, c.want)
		}
	}
}
