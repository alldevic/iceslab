package xray

import "github.com/icecompany-tech/iceslab/apps/node/internal/core"

var (
	_ core.UserCounter   = (*Adapter)(nil)
	_ core.FaultReporter = (*Adapter)(nil)
)

// CountsUsers implements core.UserCounter: per-user counters from StatsService.
func (a *Adapter) CountsUsers() bool { return true }

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
