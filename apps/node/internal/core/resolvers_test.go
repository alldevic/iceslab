package core

import (
	"context"
	"errors"
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

// fakeNet answers a dial the way a host would: IPv4 reachable, IPv6 only where
// the test says. A dial that is not an IPv6 socket succeeds, so a probe that
// forgot the family reads "works" here and the test catches it.
func fakeNet(v6ok map[string]bool) dialFunc {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		if network != "tcp6" {
			a, b := net.Pipe()
			b.Close()
			return a, nil
		}
		if v6ok[addr] {
			a, b := net.Pipe()
			b.Close()
			return a, nil
		}
		return nil, errors.New("network is unreachable")
	}
}

func TestIPv6EgressIsAskedOverAnIPv6SocketOnly(t *testing.T) {
	targets := []string{"[2606:4700:4700::1111]:443", "[2001:4860:4860::8888]:443"}
	if IPv6EgressWorks(targets, fakeNet(nil), time.Second) {
		t.Error("IPv4 reachable and IPv6 not must read as no IPv6 egress")
	}
	if !IPv6EgressWorks(targets, fakeNet(map[string]bool{targets[1]: true}), time.Second) {
		t.Error("any one target answering is enough")
	}
}

func TestIPv6EgressTargetsComeFromTheEnvOrTheDefaults(t *testing.T) {
	if got := IPv6EgressTargets(""); !reflect.DeepEqual(got, DefaultIPv6EgressTargets) {
		t.Errorf("default %v", got)
	}
	if got := IPv6EgressTargets(" , "); !reflect.DeepEqual(got, DefaultIPv6EgressTargets) {
		t.Errorf("blank entries %v", got)
	}
	got := IPv6EgressTargets("[2001:db8::1]:443, example.test:80 ,")
	if want := []string{"[2001:db8::1]:443", "example.test:80"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	// The default is a copy: a caller cannot rewrite it.
	IPv6EgressTargets("")[0] = "x"
	if DefaultIPv6EgressTargets[0] == "x" {
		t.Error("the defaults were modified through the returned slice")
	}
}

// The one answer every core reads: an address AND a connection that went out.
func TestEffectiveIPv6NeedsAnAddressAndAWorkingEgress(t *testing.T) {
	defer func(p *IPv6Prober) { sharedIPv6 = p }(sharedIPv6)
	for _, c := range []struct {
		name string
		f    IPv6Facts
		want bool
	}{
		{"address, check passed", IPv6Facts{Global: true, Egress: true}, true},
		{"address, check failed", IPv6Facts{Global: true, Egress: false}, false},
		{"no address", IPv6Facts{}, false},
		{"no address, stray egress", IPv6Facts{Egress: true}, false},
	} {
		sharedIPv6 = &IPv6Prober{ttl: time.Minute, now: time.Now, probe: func() IPv6Facts { return c.f }}
		if got := EffectiveIPv6(); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
