package core

// canListenDual is what the choice below asks: CanListenIPv6, a variable so
// tests can pin the answer, the way nodeHasIPv6 is pinned in the cores.
var canListenDual = CanListenIPv6

// ListenAddr is the address a core's inbound binds when nobody named one: `::`
// where it takes IPv4 as well (one socket for both families), else the base's
// `0.0.0.0`, which is what a host with disable_ipv6=1 or bindv6only=1 keeps,
// byte for byte. Read at every render, so it follows the host.
func ListenAddr() string {
	if canListenDual() {
		return "::"
	}
	return "0.0.0.0"
}
