package core

import "testing"

func TestListenAddr(t *testing.T) {
	defer func(f func() bool) { canListenDual = f }(canListenDual)
	for _, c := range []struct {
		dual bool
		want string
	}{{true, "::"}, {false, "0.0.0.0"}} {
		canListenDual = func() bool { return c.dual }
		if got := ListenAddr(); got != c.want {
			t.Errorf("dual=%v: got %q, want %q", c.dual, got, c.want)
		}
	}
}
