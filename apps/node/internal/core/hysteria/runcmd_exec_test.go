package hysteria

import (
	"context"
	"strings"
	"testing"
)

// The execution half of the shell-out contract.
//
// runcmd_contract_test.go compares all eight copies of this function at the
// SOURCE and pins their shape: exec.CommandContext, CombinedOutput, both values
// returned. What source comparison cannot establish is that a failing binary's
// reason actually comes back — a copy that kept CombinedOutput() and then
// returned `nil, err` on the error path passes the shape check and leaves the
// operator with "exit status 1" and nothing else. So this runs it, against a
// binary that fails on purpose and explains itself on STDERR.

func TestRunCmd_Executes(t *testing.T) {
	if err := defaultRunCmd(context.Background(), "/bin/sh", "-c", "printf iceslab"); err != nil {
		t.Fatalf("a command that succeeds returned %v", err)
	}

	// This copy folds the output INTO the error instead of returning it, so the
	// reason has to survive the wrapping.
	err := defaultRunCmd(context.Background(), "/bin/sh", "-c", "echo boom >&2; exit 3")
	if err == nil {
		t.Fatal("a command exiting 3 returned no error")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("the failing command's STDERR was dropped from the error: %v", err)
	}
	if !strings.Contains(err.Error(), "/bin/sh") {
		t.Errorf("the error should name the binary that failed: %v", err)
	}

	// The context is honoured, so a hung binary cannot pin the agent.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := defaultRunCmd(ctx, "/bin/sh", "-c", "sleep 30"); err == nil {
		t.Error("a cancelled context did not stop the command")
	}
}
