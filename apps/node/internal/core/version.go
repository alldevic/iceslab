package core

import (
	"regexp"
	"sync"
)

// CachedVersion answers "which version of its binary is this core running",
// once.
//
// Every adapter that owns a binary needs the same three things: ask the binary,
// keep the answer, and never let that question block the ones /healthz asks on
// every poll. Written out per adapter it was written once — xray's — and the
// other seven reported nothing, so the panel could not tell an operator what
// any node except an xray one was actually running.
//
// The mutex is this type's own, not the adapter's: the query shells out, and
// holding an adapter's main lock across a subprocess is what makes Healthy()
// and GetStats() wait behind it.
type CachedVersion struct {
	mu   sync.Mutex
	done bool
	v    string
}

// Get returns the cached version, calling `query` at most once. A query that
// answers "" is still cached: a binary that cannot be asked will not start
// answering later, and re-forking a process on every healthcheck to find that
// out again is the cost this exists to avoid.
func (c *CachedVersion) Get(query func() string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.done {
		return c.v
	}
	c.v = query()
	c.done = true
	return c.v
}

var semverish = regexp.MustCompile(`\d+\.\d+\.\d+`)

// ParseSemverish pulls the first `x.y.z` out of a core's version output.
//
// Deliberately one rule for several cores rather than a parser each, because
// the ONE thing their outputs have in common is that the first such triple is
// the version. That is not a guess: it was read off the real binaries this
// panel pins.
//
//	sing-box  "sing-box version 1.13.19"                    -> 1.13.19
//	mtg       "2.2.8 (go1.26.1: 2026-04-07T...)"            -> 2.2.8
//	hysteria  a banner, then "Version:\tv2.12.2"            -> 2.12.2
//	mita      "3.36.0"                                      -> 3.36.0
//
// The limit is stated rather than discovered: an upstream that puts its Go
// toolchain version first would fool this. Each adapter's test pins that
// binary's REAL output, so a format change has to be re-measured, which is the
// only way this stays true.
func ParseSemverish(out []byte) string {
	return string(semverish.Find(out))
}
