package naive

import "github.com/icecompany-tech/iceslab/apps/node/internal/core"

var (
	_ core.UserCounter   = (*Adapter)(nil)
	_ core.FaultReporter = (*Adapter)(nil)
)

// CountsUsers implements core.UserCounter: NaiveProxy keeps no per-user
// counters, the adapter reports presence only.
func (a *Adapter) CountsUsers() bool { return false }

// Fault implements core.FaultReporter: the process died, in its own words.
func (a *Adapter) Fault() string {
	a.mu.Lock()
	p := a.proc
	a.mu.Unlock()
	if p == nil || p.Running() {
		return ""
	}
	return p.ExitReason()
}
