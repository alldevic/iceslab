package mtproto

import "github.com/icecompany-tech/iceslab/apps/node/internal/core"

var (
	_ core.UserCounter   = (*Adapter)(nil)
	_ core.FaultReporter = (*Adapter)(nil)
)

// CountsUsers implements core.UserCounter: mtg has one secret for everyone
// and no users, so there is nothing per user to count.
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
