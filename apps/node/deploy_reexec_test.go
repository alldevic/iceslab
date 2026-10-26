package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 26.10 on the stand: deploy.sh updated a v0.2.1-era panel, its step 1
// replaced deploy.sh and _lib.sh on disk, and bash went on with the copies it
// had already read, so step 5 (the host Caddy, A-267) did not run. deploy.sh
// now hands over to the new copy once (reexec_if_updated in _lib.sh).
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash.

// A deploy script reduced to the hand-over: it sums itself and the library,
// "syncs" by replacing itself on disk the way a checkout does (a new file
// renamed over the old), and calls reexec_if_updated. VERSION tells the
// copies apart; SELF_CHANGING makes every run rewrite the file again, the
// case a loop guard is for.
const deployModel = `#!/usr/bin/env bash
set -euo pipefail
LIB_PREFIX=test
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SUM="$(deploy_self_sum "$SELF")"
echo "run version=VERSION reexec=${ICESLAB_DEPLOY_REEXEC:-0} before=${SHA_BEFORE:-} args=$*"
if [[ "${ICESLAB_DEPLOY_REEXEC:-0}" != 1 && -n "${NEXT:-}" ]]; then
  cp "$NEXT" "$SELF.tmp" && mv "$SELF.tmp" "$SELF"
fi
if [[ "SELF_CHANGING" == yes ]]; then echo "# $RANDOM" >>"$SELF"; fi
SHA_BEFORE=abc1234
reexec_if_updated "$SUM" "$SELF" "$@"
echo "finished version=VERSION"
`

func modelScript(version, selfChanging string) string {
	return strings.NewReplacer("VERSION", version, "SELF_CHANGING", selfChanging).Replace(deployModel)
}

func runDeployModel(t *testing.T, next string) string {
	t.Helper()
	bash := needBash(t)
	dir := filepath.Join(t.TempDir(), "scripts", "ops")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	lib, err := os.ReadFile(opsLib)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "_lib.sh"), lib, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "deploy.sh"), []byte(modelScript("OLD", "no")), 0o755); err != nil {
		t.Fatal(err)
	}
	env := []string{"PATH=/usr/bin:/bin"}
	if next != "" {
		p := filepath.Join(t.TempDir(), "next.sh")
		if err := os.WriteFile(p, []byte(next), 0o755); err != nil {
			t.Fatal(err)
		}
		env = append(env, "NEXT="+p)
	}
	cmd := exec.Command(bash, filepath.Join(dir, "deploy.sh"), "--cache", "--cleanup")
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("deploy model: %v\n%s", err, out)
	}
	return string(out)
}

func TestADeployThatChangesItselfHandsOverOnce(t *testing.T) {
	out := runDeployModel(t, modelScript("NEW", "no"))
	for _, want := range []string{
		"run version=OLD reexec=0",
		"handing over to the new one",
		"run version=NEW reexec=1 before=abc1234 args=--cache --cleanup",
		"finished version=NEW",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("want %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "finished version=OLD") {
		t.Errorf("the old copy went on after the hand-over:\n%s", out)
	}
	if n := strings.Count(out, "run version="); n != 2 {
		t.Errorf("want two runs, got %d:\n%s", n, out)
	}
}

func TestADeployThatChangesNothingRunsOnce(t *testing.T) {
	out := runDeployModel(t, "")
	if strings.Contains(out, "handing over") || strings.Count(out, "run version=") != 1 || !strings.Contains(out, "finished version=OLD") {
		t.Errorf("an unchanged deploy handed over:\n%s", out)
	}
}

// A new copy that rewrites itself on every run still runs once: the second
// run never hands over again.
func TestADeployHandsOverAtMostOnce(t *testing.T) {
	out := runDeployModel(t, modelScript("NEW", "yes"))
	if n := strings.Count(out, "run version="); n != 2 {
		t.Errorf("want exactly two runs, got %d:\n%s", n, out)
	}
	if strings.Count(out, "handing over") != 1 || !strings.Contains(out, "finished version=NEW") {
		t.Errorf("the guard did not hold:\n%s", out)
	}
}

// The real deploy.sh does it in that order: the sum before step 1 can touch
// the files, the sync, then the hand-over, and the second run skips the sync.
func TestDeployShHandsOverAfterItsSync(t *testing.T) {
	blob, err := os.ReadFile("../../scripts/ops/deploy.sh")
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	sum := strings.Index(s, `DEPLOY_SELF_SUM="$(deploy_self_sum "$DEPLOY_SELF")"`)
	sync := strings.Index(s, "\n    git_sync_to_ref\n")
	hand := strings.Index(s, `reexec_if_updated "$DEPLOY_SELF_SUM" "$DEPLOY_SELF" "$@"`)
	guard := strings.Index(s, `if [[ "${ICESLAB_DEPLOY_REEXEC:-0}" == 1 ]]; then`)
	if sum < 0 || sync < 0 || hand < 0 || guard < 0 {
		t.Fatalf("deploy.sh lacks a part of the hand-over (sum %d, sync %d, hand-over %d, guard %d)", sum, sync, hand, guard)
	}
	if !(sum < guard && guard < sync && sync < hand) {
		t.Errorf("deploy.sh: want sum < reexec guard < git_sync_to_ref < reexec_if_updated, got %d %d %d %d", sum, guard, sync, hand)
	}
}
