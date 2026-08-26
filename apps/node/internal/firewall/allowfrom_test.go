package firewall

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// AllowFrom is what pins the cascade's inter-hop link port to the previous hop
// instead of the whole internet, and runUfw is what makes the rule actually
// land. Neither had been run.
//
// Both carry a deliberate decision that reads like a bug until you know why,
// which is exactly the kind that gets "cleaned up" later: AllowFrom FAILS OPEN
// when no usable source survives, because a closed link port silently breaks
// the cascade while an open one is still UUID/PSK-gated; and runUfw retries,
// because ufw shells out to iptables and a concurrent run holding the xtables
// lock makes a single `ufw allow` exit non-zero with the rule never landing.
//
// Every case uses its own port. `allowedSpecs` is package-level and lives for
// the process, so two cases sharing a port would have the second one skip its
// fork and read as "no rule was made".

// stubUfw puts a `ufw` on PATH that records its argv and can be told to fail.
// FAIL_TIMES > 0 makes the first N calls exit non-zero with the xtables-lock
// message ufw really prints.
func stubUfw(t *testing.T, failTimes int, failMessage string) (log string) {
	t.Helper()
	dir := t.TempDir()
	log = filepath.Join(dir, "ufw.log")
	counter := filepath.Join(dir, "calls")
	script := `#!/usr/bin/env bash
printf '%s\n' "$*" >> "` + log + `"
n=$(cat "` + counter + `" 2>/dev/null || echo 0)
n=$((n + 1)); echo "$n" > "` + counter + `"
if [ "$n" -le ` + itoa(failTimes) + ` ]; then
  echo "` + failMessage + `" >&2
  exit 1
fi
exit 0
`
	if err := os.WriteFile(filepath.Join(dir, "ufw"), []byte(script), 0o755); err != nil {
		t.Fatalf("write ufw stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}

func calls(t *testing.T, log string) []string {
	t.Helper()
	b, err := os.ReadFile(log)
	if err != nil {
		return nil
	}
	var out []string
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

func silent() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestAllowFromPinsTheRuleToTheSourcesItWasGiven(t *testing.T) {
	log := stubUfw(t, 0, "")
	AllowFrom(context.Background(), silent(), 30001, "tcp", []string{"203.0.113.4", "10.0.0.0/8"})

	got := calls(t, log)
	if len(got) != 2 {
		t.Fatalf("expected one rule per source, got %d: %v", len(got), got)
	}
	for _, want := range []string{
		"allow from 203.0.113.4 to any port 30001 proto tcp",
		"allow from 10.0.0.0/8 to any port 30001 proto tcp",
	} {
		found := false
		for _, c := range got {
			if c == want {
				found = true
			}
		}
		if !found {
			t.Errorf("missing rule %q; ufw was called with:\n  %s", want, strings.Join(got, "\n  "))
		}
	}
}

func TestAllowFromOpensToAnywhereWhenNoSourceSurvives(t *testing.T) {
	// The deliberate fail-open, and the reason it is written down here: a rule
	// that cannot name a source would otherwise be no rule at all, and a closed
	// link port breaks the cascade silently. The link stays UUID/PSK-gated.
	log := stubUfw(t, 0, "")
	AllowFrom(context.Background(), silent(), 30002, "tcp",
		[]string{"", "   ", "no-such-host.invalid"})

	got := calls(t, log)
	if len(got) == 0 {
		t.Fatal("no source survived and no rule was made at all: the hop is closed")
	}
	joined := strings.Join(got, "\n")
	if !strings.Contains(joined, "allow 30002/tcp") {
		t.Errorf("expected a plain open rule, ufw was called with:\n  %s", joined)
	}
	if strings.Contains(joined, "from") {
		t.Errorf("a source was invented from unusable input:\n  %s", joined)
	}
}

func TestAllowFromRefusesAPortOrProtoItCannotMean(t *testing.T) {
	// The control on every case above: these must produce NO rule, or "a rule
	// was made" is true of a function that always makes one.
	for _, tc := range []struct {
		name  string
		port  int
		proto string
	}{
		{"port zero", 0, "tcp"},
		{"port above the range", 70000, "tcp"},
		{"not a proto", 30003, "sctp"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			log := stubUfw(t, 0, "")
			AllowFrom(context.Background(), silent(), tc.port, tc.proto, []string{"203.0.113.4"})
			if got := calls(t, log); len(got) != 0 {
				t.Errorf("made a rule anyway: %v", got)
			}
		})
	}
}

func TestAllowFromAsksOncePerSourcePerProcess(t *testing.T) {
	// N11: every applyInbound re-calls this for the same ports, and `ufw allow`
	// forks even when the rule exists. The cache is the reason a cascade swap
	// does not fork ufw a dozen times.
	log := stubUfw(t, 0, "")
	for i := 0; i < 3; i++ {
		AllowFrom(context.Background(), silent(), 30004, "udp", []string{"198.51.100.7", "198.51.100.7"})
	}
	if got := calls(t, log); len(got) != 1 {
		t.Errorf("expected one fork for one source repeated six times, got %d: %v", len(got), got)
	}
}

func TestRunUfwRetriesWhileTheXtablesLockIsHeld(t *testing.T) {
	// ufw shells out to iptables, which takes a global lock. A concurrent run —
	// ufw's own reload, fail2ban, docker — makes a single attempt exit non-zero
	// and the rule it was adding never lands, breaking the hop until the next
	// apply. Nothing about the node looks wrong afterwards.
	log := stubUfw(t, 2, "ERROR: could not get lock on /run/xtables.lock")
	out, err := runUfw(context.Background(), "allow", "30005/tcp")
	if err != nil {
		t.Fatalf("gave up while the lock was held: %v (%s)", err, out)
	}
	if got := calls(t, log); len(got) != 3 {
		t.Errorf("expected two failed attempts and a third that stuck, got %d", len(got))
	}
}

func TestRunUfwDoesNotRetryARealFailure(t *testing.T) {
	// The other half, and the one that keeps the retry honest: a wrong rule is
	// wrong on every attempt, and retrying it three more times only delays the
	// error the caller needs.
	log := stubUfw(t, 99, "ERROR: Bad port")
	if _, err := runUfw(context.Background(), "allow", "not-a-port"); err == nil {
		t.Fatal("a rejected rule was reported as success")
	}
	if got := calls(t, log); len(got) != 1 {
		t.Errorf("retried a failure that is not lock contention: %d attempts", len(got))
	}
}
