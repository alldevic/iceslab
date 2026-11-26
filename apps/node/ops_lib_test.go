package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// scripts/ops/_lib.sh under the deploy scripts: `retry` returned 0 after every
// attempt had failed (rc=$? after an if without else), and a deploy ended with
// "deploy complete" whatever state the backend was in (wait_container_healthy).
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash.

// opsProg: the definitions of `fns` from scripts/ops/_lib.sh, plus stub
// log helpers (the caller puts a no-op `sleep` on PATH).
func opsProg(t *testing.T, fns ...string) string {
	t.Helper()
	lib, err := os.ReadFile(opsLib)
	if err != nil {
		t.Fatal(err)
	}
	prog := "set -uo pipefail\nlog_info() { echo \"info: $*\"; }\nlog_warn() { echo \"warn: $*\"; }\nlog_err() { echo \"err: $*\"; }\n"
	for _, fn := range fns {
		prog += fnBody(t, string(lib), fn) + "\n"
	}
	return prog
}

func TestRetryReturnsTheLastExitCodeWhenEveryAttemptFails(t *testing.T) {
	needBash(t)
	dir := t.TempDir()
	count := filepath.Join(dir, "count")
	bin := stubs(t, map[string]string{"sleep": "exit 0\n"})
	// flaky <fail-until> <code>: fails with <code> until its <fail-until>th call.
	flaky := `flaky() { local n; n=$(( $(cat '` + count + `' 2>/dev/null || echo 0) + 1 )); echo $n >'` + count + `'; (( n >= $1 )) && return 0; return $2; }` + "\n"
	cases := []struct {
		name      string
		failUntil int
		want      string
		calls     string
	}{
		{"succeeds first time", 1, "rc=0", "1"},
		{"succeeds second time", 2, "rc=0", "2"},
		{"exhausts the attempts, keeps the code", 99, "rc=7", "3"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_ = os.Remove(count)
			prog := opsProg(t, "retry") + flaky + "retry 3 flaky " + strconv.Itoa(c.failUntil) + " 7\necho rc=$?\n"
			out, err := runBash(t, bin, prog)
			if err != nil || !strings.Contains(out, c.want+"\n") {
				t.Fatalf("want %s: %v\n%s", c.want, err, out)
			}
			if b, _ := os.ReadFile(count); strings.TrimSpace(string(b)) != c.calls {
				t.Fatalf("want %s calls, got %q\n%s", c.calls, b, out)
			}
		})
	}
}

func TestWaitContainerHealthy(t *testing.T) {
	needBash(t)
	// The docker stub answers `inspect` with the next word of $STATES (the
	// last one repeats), counting the polls in a file; sleep is a no-op.
	run := func(t *testing.T, states, args string) (string, int, error) {
		t.Helper()
		dir := t.TempDir()
		counter := filepath.Join(dir, "polls")
		bin := stubs(t, map[string]string{
			"sleep": "exit 0\n",
			"docker": `[ "$1" = inspect ] || exit 1
n=$(( $(cat '` + counter + `' 2>/dev/null || echo 0) + 1 )); echo $n >'` + counter + `'
set -- ` + states + `
i=1; for w in "$@"; do [ $i -eq $n ] && { echo "$w"; exit 0; }; i=$((i+1)); done
eval "echo \$$#"
`,
		})
		out, err := runBash(t, bin, opsProg(t, "wait_container_healthy")+"wait_container_healthy "+args+"\necho rc=$?\n")
		b, _ := os.ReadFile(counter)
		polls, _ := strconv.Atoi(strings.TrimSpace(string(b)))
		return out, polls, err
	}
	cases := []struct {
		name, states, args, rc string
		polls                  int
	}{
		{"healthy at once", "healthy", "cid 150", "0", 1},
		{"healthy after several polls", "starting starting starting healthy", "cid 150", "0", 4},
		{"unhealthy ends the wait at once", "starting unhealthy", "cid 150", "1", 2},
		{"exited ends the wait at once", "exited", "cid 150", "1", 1},
		{"budget runs out", "starting", "cid 9", "1", 3},
		{"restarting never becomes healthy", "restarting", "cid 6", "1", 2},
		{"no healthcheck, running", "running", "cid 60", "0", 1},
		{"no healthcheck, created then running", "created running", "cid 60", "0", 2},
		{"no container id", "healthy", "'' 60", "1", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, polls, err := run(t, c.states, c.args)
			if err != nil || !strings.Contains(out, "rc="+c.rc+"\n") {
				t.Fatalf("want rc=%s: %v\n%s", c.rc, err, out)
			}
			if polls != c.polls {
				t.Fatalf("want %d polls, got %d\n%s", c.polls, polls, out)
			}
			if c.rc == "1" && !strings.Contains(out, "err: ") {
				t.Fatalf("a refusal says why:\n%s", out)
			}
		})
	}
}

// LASTSAVE has one-second resolution: a BGSAVE that ends in the same second as
// the baseline read leaves it unchanged, and iceslab-backup.sh called the good
// snapshot stale (seen on the stand right after FLUSHALL).
func TestBackupSurvivesASaveInTheSameSecondAsTheBaseline(t *testing.T) {
	needBash(t)
	blob, err := os.ReadFile("../../scripts/ops/iceslab-backup.sh")
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	from := strings.Index(s, `prev_lastsave="$(`)
	to := strings.Index(s, "if [[ $bgsave_ok -ne 1 ]]")
	if from < 0 || to < from {
		t.Fatal("step 2 of iceslab-backup.sh not found")
	}
	dir := t.TempDir()
	last := filepath.Join(dir, "lastsave")
	bin := stubs(t, map[string]string{
		"sleep": "exec /bin/sleep 0.2\n",
		// a redis whose BGSAVE finishes at once, at the current second
		"docker": `case "$4" in
LASTSAVE) cat '` + last + `';;
BGSAVE) date +%s >'` + last + `'; echo Started;;
TIME) date +%s; echo 1;;
esac
`,
	})
	prog := "set -euo pipefail\nREDIS_CONTAINER=r\nlog_err() { echo \"err: $*\"; }\n" +
		"date +%s >'" + last + "'\n" + s[from:to] + "echo bgsave_ok=$bgsave_ok\n"
	out, err := runBash(t, bin, prog)
	if err != nil || !strings.Contains(out, "bgsave_ok=1") {
		t.Fatalf("a save in the baseline's second read as stale: %v\n%s", err, out)
	}
}
