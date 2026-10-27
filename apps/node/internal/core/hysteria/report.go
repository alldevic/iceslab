package hysteria

import "github.com/icecompany-tech/iceslab/apps/node/internal/core"

var (
	_ core.UserCounter   = (*Adapter)(nil)
	_ core.FaultReporter = (*Adapter)(nil)
)

// CountsUsers implements core.UserCounter: per-user counters come from the
// traffic stats API, when it is configured.
func (a *Adapter) CountsUsers() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.cfg.TrafficStatsListen != "" && a.cfg.TrafficStatsSecret != ""
}

// Fault implements core.FaultReporter: in spawn mode, the process died, in its
// own words. Under systemd the unit is the one to ask, and this says nothing.
func (a *Adapter) Fault() string {
	a.mu.RLock()
	p := a.proc
	a.mu.RUnlock()
	if p == nil || p.Running() {
		return ""
	}
	return p.ExitReason()
}
