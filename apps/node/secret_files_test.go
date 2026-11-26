package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// A file with a secret in it never exists with a mode wider than 0600, not even
// for the time between its creation and a chmod. `cat > f` makes a 0644 file
// under the default umask; `chmod 600` afterwards narrows what is left of an
// old install but leaves that window. So every `chmod 600 <file>` of a secret
// is preceded by `install -m 0600 /dev/null <file>` that creates it empty.
//
// ⚠ Reads files outside the package: `go test -count=1` locally.

var secretFileScripts = []string{
	"../../scripts/install-iceslab.sh",
	"../../scripts/install-iceslab-node.sh",
	"../../scripts/ops/iceslab-backup.sh",
	"scripts/bootstrap-singbox.sh",
}

var chmod600 = regexp.MustCompile(`^\s*chmod 600 (\S+)\s*$`)

func TestSecretFilesAreCreated0600BeforeTheyAreWritten(t *testing.T) {
	seen := 0
	for _, path := range secretFileScripts {
		blob, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Split(string(blob), "\n")
		for i, l := range lines {
			m := chmod600.FindStringSubmatch(l)
			if m == nil {
				continue
			}
			target := strings.Trim(m[1], `"`)
			// Swap is made with fallocate/dd, which write no secret; its chmod is
			// there because swapon refuses a file readable by others.
			if target == "/swapfile" {
				continue
			}
			seen++
			want := regexp.MustCompile(`install -m 0600 /dev/null "?` + regexp.QuoteMeta(target) + `"?\s*$`)
			found := false
			for j := i - 1; j >= 0 && i-j <= 120; j-- {
				if want.MatchString(lines[j]) {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("%s:%d: chmod 600 %s has no `install -m 0600 /dev/null %s` in the 120 lines before it: the file exists wider than 0600 while the secret is written", path, i+1, target, target)
			}
		}
	}
	// Control: the rule has to find the places it is about (.env.production, the
	// node env, key.pem and the two archive variants), or it passes on nothing.
	if seen < 5 {
		t.Errorf("only %d chmod 600 of a secret file found in the four scripts, expected at least 5: was the pattern or a script renamed?", seen)
	}
}
