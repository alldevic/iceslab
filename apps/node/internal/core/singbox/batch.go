package singbox

import (
	"time"
)

/*
User changes are restarted in batches (A-119, 22.10).

sing-box 1.13.14 has no live user management for these inbounds (the SSM API
is shadowsocks only) and its SIGHUP reload closes the box and builds a new one,
so an open connection ends either way (checked live: the stream read EOF after
SIGHUP). Each AddUser restarted the process, and after a push the panel sends
the roster one user at a time: on a large node that was one restart per user,
every connection on this protocol dropped thousands of times in a row.

Changes now wait for quiet (QuietWindow after the last one) and never longer
than MaxWait from the first one of the batch, so a steady stream of sales
cannot hold the restart off forever. AddUser answers at once; a restart that
fails shows on /healthz as the process not running. Anything that renders
anyway (ApplyInbound, Idle, Stop) takes the pending batch with it.
*/

const (
	defaultQuietWindow = 2 * time.Second
	defaultMaxWait     = 10 * time.Second
)

// batchClock is the time the batch reads: the wall clock in the agent, a
// clock a test steps by hand, so the quiet window and the cap are tested as
// rules and not as how fast a loaded runner happens to be.
type batchClock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) stopper
}

type stopper interface{ Stop() bool }

type wallClock struct{}

func (wallClock) Now() time.Time { return time.Now() }

func (wallClock) AfterFunc(d time.Duration, f func()) stopper { return time.AfterFunc(d, f) }

// scheduleRestart puts a user change into the pending batch.
func (a *Adapter) scheduleRestart() {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.clock.Now()
	if a.batchTimer == nil {
		a.batchFirst = now
	} else {
		a.batchTimer.Stop()
	}
	delay := a.cfg.QuietWindow
	if until := a.batchFirst.Add(a.cfg.MaxWait).Sub(now); until < delay {
		delay = until
	}
	if delay < 0 {
		delay = 0
	}
	a.batchTimer = a.clock.AfterFunc(delay, a.flushBatch)
}

// flushBatch is the batch's one restart.
func (a *Adapter) flushBatch() {
	a.mu.Lock()
	a.batchTimer = nil
	flushed := a.onFlush
	a.mu.Unlock()
	if flushed != nil {
		flushed()
	}
	if err := a.regenerateAndRestart(); err != nil {
		a.logger.Error("singbox: restart for a batch of user changes failed", "protocol", a.protocol, "err", err)
	}
}

// dropBatchLocked forgets a pending batch: the caller renders the current
// users itself. a.mu held.
func (a *Adapter) dropBatchLocked() {
	if a.batchTimer != nil {
		a.batchTimer.Stop()
		a.batchTimer = nil
	}
}
