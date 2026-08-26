package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// Shutdown is a fan-out, and a fan-out has one way to go wrong quietly.
//
// stopAdapters runs on three paths, and the third is the expensive one: when
// the panel tells a node to self-destruct, the agent stops every core and exits
// 42. If one core's Stop returns an error and the loop treats that as a reason
// to give up, every core AFTER it in the slice keeps running — a node that was
// told to stop serving, still serving, with an exit code that says it complied.
// The loop reads correctly today; nothing had asked it.
//
// The deadline is shared, one context for the whole fan-out, so it is also
// worth pinning that a core is handed one that actually expires.

type stubAdapter struct {
	name     string
	stopErr  error
	stopped  bool
	sawCtx   context.Context
	stopHook func()
}

func (s *stubAdapter) Name() string                            { return s.name }
func (s *stubAdapter) Engine() string                          { return "stub" }
func (s *stubAdapter) Start(context.Context) error             { return nil }
func (s *stubAdapter) AddUser(core.User) error                 { return nil }
func (s *stubAdapter) RemoveUser(string) error                 { return nil }
func (s *stubAdapter) GetStats() (*core.Stats, error)          { return &core.Stats{}, nil }
func (s *stubAdapter) Healthy() bool                           { return !s.stopped }
func (s *stubAdapter) ApplyInbound(int, json.RawMessage) error { return nil }

func (s *stubAdapter) Stop(ctx context.Context) error {
	s.stopped = true
	s.sawCtx = ctx
	if s.stopHook != nil {
		s.stopHook()
	}
	return s.stopErr
}

func TestStopAdapters_OneFailureDoesNotStrandTheRest(t *testing.T) {
	first := &stubAdapter{name: "xray"}
	broken := &stubAdapter{name: "hysteria", stopErr: errors.New("did not stop within 5s, killed")}
	last := &stubAdapter{name: "tuic"}

	stopAdapters([]core.CoreAdapter{first, broken, last},
		slog.New(slog.NewTextHandler(io.Discard, nil)))

	for _, a := range []*stubAdapter{first, broken, last} {
		if !a.stopped {
			t.Errorf("%s was never stopped; a core left running after shutdown still holds its port and still serves traffic", a.name)
		}
	}
	if last.sawCtx == nil {
		t.Fatal("the adapter after the failing one got no context at all")
	}
}

// Every adapter shares ONE deadline for the whole fan-out. A core that hangs
// must therefore hand the next one a context that is already expiring rather
// than a fresh five seconds each, or a node with six cores could take half a
// minute to die.
func TestStopAdapters_SharesOneDeadlineAcrossTheFanOut(t *testing.T) {
	first := &stubAdapter{name: "a"}
	second := &stubAdapter{name: "b"}

	stopAdapters([]core.CoreAdapter{first, second},
		slog.New(slog.NewTextHandler(io.Discard, nil)))

	firstDeadline, ok1 := first.sawCtx.Deadline()
	secondDeadline, ok2 := second.sawCtx.Deadline()
	if !ok1 || !ok2 {
		t.Fatal("shutdown context carries no deadline, so a hung core blocks the agent forever")
	}
	if !firstDeadline.Equal(secondDeadline) {
		t.Errorf("each adapter got its own deadline (%s vs %s); the budget is meant to be shared",
			firstDeadline, secondDeadline)
	}
	if d := time.Until(firstDeadline); d <= 0 || d > adapterStopShutdownTimeout {
		t.Errorf("deadline is %s away, want (0, %s]", d, adapterStopShutdownTimeout)
	}
}

// The empty slice is the state a node reaches when every protocol is disabled.
func TestStopAdapters_NoAdaptersIsNotAPanic(t *testing.T) {
	stopAdapters(nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
}
