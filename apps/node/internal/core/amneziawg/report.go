package amneziawg

import "github.com/icecompany-tech/iceslab/apps/node/internal/core"

var _ core.UserCounter = (*Adapter)(nil)

// CountsUsers implements core.UserCounter: per-peer counters from `awg show
// dump`.
func (a *Adapter) CountsUsers() bool { return true }
