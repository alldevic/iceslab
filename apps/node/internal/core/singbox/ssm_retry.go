package singbox

import (
	"context"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

const ssmRetryMax = 30 * time.Second

// ssmSyncAll hands every held inbound its users over ssm-api.
func (a *Adapter) ssmSyncAll(ctx context.Context, held []heldInbound, users map[string]userEntry) error {
	for _, h := range held {
		want := make(map[string]string, len(users))
		for id, u := range users {
			if u.servesOn(h.id) {
				want[id] = core.DeriveSsPassword(u.Password, h.cfg.Method)
			}
		}
		if err := a.ssm().at(ssmPath(h.id)).sync(ctx, want); err != nil {
			return err
		}
	}
	return nil
}

// retrySSMSync tries the hand-over again, 1, 2, 4 ... 30 s apart, for as long
// as the process it was started for is the current one and the adapter runs.
// A newer start brings its own hand-over, and Stop/Idle end it.
func (a *Adapter) retrySSMSync(ctx context.Context, gen int, held []heldInbound, users map[string]userEntry) {
	a.mu.Lock()
	wait := a.ssmRetryBase
	a.mu.Unlock()
	if wait <= 0 {
		wait = time.Second
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		a.mu.Lock()
		current := a.ssmGen == gen && a.started && a.proc != nil
		// The users as they are now, not as they were at the start: changes
		// made meanwhile are in the map, and a later sync must not undo them.
		now := make(map[string]userEntry, len(a.users))
		for k, v := range a.users {
			now[k] = v
		}
		a.mu.Unlock()
		if !current {
			return
		}
		err := a.ssmSyncAll(ctx, held, now)
		a.mu.Lock()
		if err == nil && a.ssmGen == gen {
			a.ssmSynced = true
			a.mu.Unlock()
			a.logger.Info("singbox: users handed to ssm-api after a retry")
			return
		}
		a.mu.Unlock()
		if err != nil {
			a.logger.Warn("singbox: ssm-api hand-over still failing, retrying", "err", err, "in", wait*2)
		}
		if wait *= 2; wait > ssmRetryMax {
			wait = ssmRetryMax
		}
	}
}
