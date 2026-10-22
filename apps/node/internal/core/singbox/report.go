package singbox

import "github.com/icecompany-tech/iceslab/apps/node/internal/core"

var (
	_ core.UserCounter   = (*Adapter)(nil)
	_ core.FaultReporter = (*Adapter)(nil)
)

// CountsUsers implements core.UserCounter: a managed shadowsocks counts over
// ssm-api with any build; everything else only when the binary carries
// v2ray_api (countsUsers), presence without bytes otherwise.
func (a *Adapter) CountsUsers() bool {
	return a.ssmOn() || a.countsUsers()
}

// Fault implements core.FaultReporter: the process died, in its own words;
// else a hand-over to ssm-api still pending (A-213), with its last failure.
func (a *Adapter) Fault() string {
	a.mu.Lock()
	p := a.proc
	pending := a.ssmOn() && len(a.inbounds) > 0 && !a.ssmSynced
	lastErr := a.ssmErr
	a.mu.Unlock()
	if p == nil {
		return ""
	}
	if !p.Running() {
		return p.ExitReason()
	}
	if !pending {
		return ""
	}
	if lastErr == "" {
		return "ssm-api sync pending"
	}
	return "ssm-api sync pending: " + lastErr
}
