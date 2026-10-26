package mieru

import "github.com/icecompany-tech/iceslab/apps/node/internal/core"

var (
	_ core.UserCounter = (*Adapter)(nil)
	_ core.Waiter      = (*Adapter)(nil)
)

// Waiting implements core.Waiter: mita holds a mieru inbound with no user on
// it, and its proxy stays down until the first one (A-275).
func (a *Adapter) Waiting() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.waiting && len(a.inbounds) > 0 {
		return core.NoUsersReason
	}
	return ""
}

// CountsUsers implements core.UserCounter: the adapter does not read mita's
// metrics yet, it reports presence only.
func (a *Adapter) CountsUsers() bool { return false }
