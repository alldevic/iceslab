//go:build !linux

package subprocess

import "errors"

// Non-Linux fallback. Production node-agents run on Linux; this keeps
// `go build ./...` green on a Windows/macOS dev box. Returning an error (not a
// zero) is deliberate: zero would read as "0 bytes resident", i.e. always under
// the ceiling, which silently pretends the watchdog is working. The watchdog
// logs this once and leaves the ceiling unenforced.
var errRSSUnsupported = errors.New("process RSS: only implemented on linux")

func readRSSBytes(_ int) (uint64, error) {
	return 0, errRSSUnsupported
}
