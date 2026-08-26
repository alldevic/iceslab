package zapret2

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
	out, err := defaultRunCmd(context.Background(), "/bin/sh", "-c", "printf iceslab")
	if err != nil {
		t.Fatalf("a command that succeeds returned %v (output %q)", err, out)
	}
	if string(out) != "iceslab" {
		t.Errorf("stdout: got %q want %q", out, "iceslab")
	}

	// STDERR is the half that matters: a core refusing a config says why there.
	out, err = defaultRunCmd(context.Background(), "/bin/sh", "-c", "echo boom >&2; exit 3")
	if err == nil {
		t.Fatal("a command exiting 3 returned no error")
	}
	if !strings.Contains(string(out), "boom") {
		t.Errorf("the failing command's STDERR was dropped; got %q. Callers log this string, and without it the operator sees only %q",
			out, err)
	}

	// The context is honoured, so a hung binary cannot pin the agent.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := defaultRunCmd(ctx, "/bin/sh", "-c", "sleep 30"); err == nil {
		t.Error("a cancelled context did not stop the command")
	}
}
