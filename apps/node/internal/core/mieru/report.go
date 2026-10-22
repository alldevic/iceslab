package mieru

import "github.com/icecompany-tech/iceslab/apps/node/internal/core"

var _ core.UserCounter = (*Adapter)(nil)

// CountsUsers implements core.UserCounter: the adapter does not read mita's
// metrics yet, it reports presence only.
func (a *Adapter) CountsUsers() bool { return false }
