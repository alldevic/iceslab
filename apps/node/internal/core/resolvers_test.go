package core

import (
	"net"
	"reflect"
	"testing"
	"time"
)

func ipnet(t *testing.T, cidr string) net.Addr {
	t.Helper()
	ip, n, err := net.ParseCIDR(cidr)
	if err != nil {
		t.Fatal(err)
	}
	n.IP = ip
	return n
}

// Only an address that reaches the internet counts: link-local, unique-local
// (fc00::/7), loopback and IPv4 stay out, and the list is sorted and deduped so
// the panel's stored copy does not change between polls.
func TestGlobalIPv6FromKeepsOnlyGlobalAddressesSorted(t *testing.T) {
	got := globalIPv6From([]net.Addr{
		ipnet(t, "fe80::1/64"),
		ipnet(t, "fd12:3456::1/64"),
		ipnet(t, "fc00::2/7"),
		ipnet(t, "::1/128"),
		ipnet(t, "192.0.2.1/24"),
		ipnet(t, "2001:db8::9/64"),
		ipnet(t, "2001:db8::1/64"),
		ipnet(t, "2001:db8::9/64"),
		&net.IPAddr{IP: net.ParseIP("2001:db8::5")},
	})
	want := []string{"2001:db8::1", "2001:db8::9"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if none := globalIPv6From(nil); none == nil || len(none) != 0 {
		t.Errorf("no addresses must be an empty list, got %#v", none)
	}
}

func TestIPv6ProberCachesUntilTheTTLPasses(t *testing.T) {
	now := time.Unix(1000, 0)
	calls := 0
	p := &IPv6Prober{
		ttl:   time.Minute,
		now:   func() time.Time { return now },
		probe: func() IPv6Facts { calls++; return IPv6Facts{Stack: calls > 1} },
	}
	if p.Facts().Stack || p.Facts().Stack || calls != 1 {
		t.Fatalf("second call inside the ttl must reuse the first, calls=%d", calls)
	}
	now = now.Add(61 * time.Second)
	if !p.Facts().Stack || calls != 2 {
		t.Errorf("after the ttl the probe runs again, calls=%d", calls)
	}
}

// Runs the real probe: either answer is valid on the machine the test runs on,
// but it must not hang or panic, and Global must agree with the list.
func TestProbeIPv6IsConsistent(t *testing.T) {
	f := ProbeIPv6()
	if f.Global != (len(f.Addresses) > 0) {
		t.Errorf("global %v with %d addresses", f.Global, len(f.Addresses))
	}
}
