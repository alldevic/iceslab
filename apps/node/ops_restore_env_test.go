package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// m7.4: iceslab-restore.sh kept the archive's env as `.env.production.from-backup-*`
// in the checkout, and the next deploy*.sh refused the dirty tree. The copy now
// lies outside it, and the deploy says "NOT complete" when `up -d --build` fails.
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash.

func TestRestoreKeepsTheArchivesEnvOutsideTheCheckout(t *testing.T) {
	blob, err := os.ReadFile("../../scripts/ops/iceslab-restore.sh")
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	i := strings.Index(s, "ARCHIVE_ENV=\"\"\n")
	j := strings.Index(s, "echo\nlog_ok \"restore complete")
	if i == -1 || j == -1 || j < i {
		t.Fatal("the env copy block is not where this test looks")
	}
	dir := t.TempDir()
	checkout := filepath.Join(dir, "checkout")
	stage := filepath.Join(dir, "stage")
	for _, d := range []string{checkout, stage} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(stage, "env"), []byte("JWT_SECRET=x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(dir, "state")
	prog := "set -euo pipefail\ncd '" + checkout + "'\nSTAGE='" + stage + "'\nENV_FILE=.env.production\nARCHIVE=/b/iceslab-backup-1.tar.gz.enc\n" +
		"export ICESLAB_RESTORE_ENV_DIR='" + state + "'\n" + s[i:j] + "echo \"PATH=$ARCHIVE_ENV\"\n"
	out, err := runBash(t, "/usr/bin", prog)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	want := filepath.Join(state, ".env.production.from-backup-iceslab-backup-1")
	if !strings.Contains(out, "PATH="+want+"\n") {
		t.Fatalf("want the copy at %s:\n%s", want, out)
	}
	st, err := os.Stat(want)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("copy: %v %v", st, err)
	}
	if left, _ := filepath.Glob(filepath.Join(checkout, ".env*")); len(left) != 0 {
		t.Errorf("files left in the checkout: %v", left)
	}
	if !strings.Contains(s, `the archive's copy is ${ARCHIVE_ENV}`) {
		t.Error("the restore no longer prints where the copy is")
	}
}

func TestDeployNamesTheHalfFinishedStateWhenUpFails(t *testing.T) {
	blob, err := os.ReadFile("../../scripts/ops/deploy.sh")
	if err != nil {
		t.Fatal(err)
	}
	s := string(blob)
	i := strings.Index(s, "\"${DC[@]}\" up -d --build || {")
	if i == -1 {
		t.Fatal("`up -d --build` is not guarded")
	}
	blk := s[i : i+strings.Index(s[i:], "step_done")]
	for _, want := range []string{"NOT complete", "ICESLAB_REF=<previous tag>", `(exit "$_up_rc")`} {
		if !strings.Contains(blk, want) {
			t.Errorf("the guard lacks %q", want)
		}
	}
	// Run it: a failing docker prints the message and still ends in a non-zero ERR.
	prog := "set -Eeuo pipefail\nlog_err() { echo \"err: $*\"; }\ntrap 'echo TRAP rc=$?' ERR\nDC=(false)\n" + blk + "echo REACHED\n"
	out, err := runBash(t, "/usr/bin", prog)
	if err == nil || strings.Contains(out, "REACHED") || !strings.Contains(out, "NOT complete") || !strings.Contains(out, "TRAP") {
		t.Fatalf("err=%v\n%s", err, out)
	}
}
