package mtprotoproxy

import "github.com/icecompany-tech/iceslab/apps/node/internal/core"

var (
	_ core.CoreAdapter     = (*Adapter)(nil)
	_ core.Provisionable   = (*Adapter)(nil)
	_ core.Idler           = (*Adapter)(nil)
	_ core.Installable     = (*Adapter)(nil)
	_ core.PortReserver    = (*Adapter)(nil)
	_ core.UserCounter     = (*Adapter)(nil)
	_ core.FaultReporter   = (*Adapter)(nil)
	_ core.RestartReporter = (*Adapter)(nil)
)

// CountsUsers implements core.UserCounter. False until the metrics scrape lands
// (milestone 8.4): like mtg's until then, no bytes are attributed to a user.
func (a *Adapter) CountsUsers() bool { return false }

// Fault implements core.FaultReporter: why the core is not working, in its own
// words, or the agent's when it was never spawned (the crypto guard).
func (a *Adapter) Fault() string {
	a.mu.Lock()
	p, refusal := a.proc, a.refusal
	a.mu.Unlock()
	if refusal != "" {
		return refusal
	}
	if p == nil || p.Running() {
		return ""
	}
	return p.ExitReason()
}
