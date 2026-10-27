package core

import (
	"sync"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

// RestartTally counts one adapter's core restarts for RestartReporter: wire
// Record as the subprocess's OnRestart and answer RestartStats from Stats.
// Every core that owns a process has one, not only xray: the watchdog and the
// crash watcher bounce any of them, a restart drops live connections, and a
// core with no tally bounced without a trace while its node stayed green.
//
// Nil-safe, so an adapter built as a bare literal in a test does not panic.
type RestartTally struct {
	mu         sync.Mutex
	crash      int
	memory     int
	lastAt     time.Time
	lastReason string
	since      time.Time
}

// NewRestartTally starts counting now (RestartStats.SinceAt).
func NewRestartTally() *RestartTally { return &RestartTally{since: time.Now()} }

// Record is a subprocess.Config.OnRestart: cheap, never blocks.
func (t *RestartTally) Record(ev subprocess.RestartEvent) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if ev.Reason == subprocess.RestartReasonMemory {
		t.memory++
	} else {
		t.crash++
	}
	t.lastAt = ev.At
	t.lastReason = string(ev.Reason)
}

// Stats is the tally as RestartStats, with the armed memory ceiling and the
// latest RSS sample the caller has.
func (t *RestartTally) Stats(memoryLimit, rss uint64) RestartStats {
	if t == nil {
		return RestartStats{MemoryLimitBytes: memoryLimit, RSSBytes: rss}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return RestartStats{
		Crash:            t.crash,
		Memory:           t.memory,
		LastAt:           t.lastAt,
		LastReason:       t.lastReason,
		SinceAt:          t.since,
		MemoryLimitBytes: memoryLimit,
		RSSBytes:         rss,
	}
}
