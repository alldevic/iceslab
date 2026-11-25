package subprocess

import (
	"context"
	"testing"
	"time"
)

// A process that exits inside the window is not alive at its end, even though
// the supervisor has a respawn queued behind its backoff.
func TestAliveAfter_ProcessThatExitsInsideTheWindowIsNotAlive(t *testing.T) {
	proc := New(Config{
		Name:           "dies",
		Binary:         "/bin/true",
		Logger:         newSilentLogger(),
		MaxRestarts:    3,
		RestartBackoff: 5 * time.Second,
	})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer proc.Stop(context.Background())
	if proc.AliveAfter(context.Background(), 300*time.Millisecond) {
		t.Fatal("a process that exited at once was reported alive")
	}
}

// The control: without it the case above passes for an inverted check.
func TestAliveAfter_ProcessThatStaysUpIsAlive(t *testing.T) {
	proc := New(Config{Name: "stays", Binary: "/bin/sleep", Args: []string{"30"}, Logger: newSilentLogger()})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer proc.Stop(context.Background())
	start := time.Now()
	if !proc.AliveAfter(context.Background(), 150*time.Millisecond) {
		t.Fatal("a running process was reported dead")
	}
	if time.Since(start) < 140*time.Millisecond {
		t.Errorf("returned after %s, before the window ended", time.Since(start))
	}
}

// A cancelled context ends the wait early and still answers truthfully.
func TestAliveAfter_CancelledContextEndsTheWaitEarly(t *testing.T) {
	proc := New(Config{Name: "stays", Binary: "/bin/sleep", Args: []string{"30"}, Logger: newSilentLogger()})
	if err := proc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer proc.Stop(context.Background())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if !proc.AliveAfter(ctx, 10*time.Second) {
		t.Error("a running process was reported dead on a cancelled context")
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("a cancelled context did not end the wait: %s", time.Since(start))
	}
}

// A process never started is not alive.
func TestAliveAfter_NeverStartedIsNotAlive(t *testing.T) {
	proc := New(Config{Name: "x", Binary: "/bin/true", Logger: newSilentLogger()})
	if proc.AliveAfter(context.Background(), time.Millisecond) {
		t.Fatal("an unstarted process was reported alive")
	}
}
