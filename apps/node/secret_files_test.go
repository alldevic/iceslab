package main

import (
	"fmt"
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
	"scripts/lib/node-env.sh",
}

var chmod600 = regexp.MustCompile(`^\s*chmod 600 (\S+)\s*$`)

// secretFileProblems checks every `chmod 600 <file>` of the script `text` (named
// path in messages) and returns how many it checked and what is wrong with them.
func secretFileProblems(path, text string) (seen int, problems []string) {
	lines := strings.Split(text, "\n")
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
		// node-env.sh edits a copy of the env file: its temp file comes from
		// mktemp, which makes it 0600 already; the chmod is belt and braces.
		if target == "$tmp" {
			want = regexp.MustCompile(`\btmp="\$\(mktemp `)
		}
		found := false
		for j := i - 1; j >= 0 && i-j <= 120; j-- {
			if want.MatchString(lines[j]) {
				found = true
				break
			}
		}
		if !found {
			problems = append(problems, fmt.Sprintf("%s:%d: chmod 600 %s has no earlier creation with mode 0600 (%s) in the 120 lines before it: the file exists wider than 0600 while the secret is written", path, i+1, target, want))
		}
	}
	return seen, problems
}

func TestSecretFilesAreCreated0600BeforeTheyAreWritten(t *testing.T) {
	seen := 0
	for _, path := range secretFileScripts {
		blob, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		n, problems := secretFileProblems(path, string(blob))
		seen += n
		for _, p := range problems {
			t.Error(p)
		}
	}
	// Control: the rule has to find the places it is about (.env.production, the
	// node env, key.pem, the two archive variants and the two temp files of
	// node-env.sh), or it passes on nothing.
	if seen < 7 {
		t.Errorf("only %d chmod 600 of a secret file found in the five scripts, expected at least 7: was the pattern or a script renamed?", seen)
	}
}

// The rule is not an empty one: take the creation out of the node installer and
// the test reports that place and no other.
func TestSecretFilesRuleCatchesALostCreation(t *testing.T) {
	blob, err := os.ReadFile("../../scripts/install-iceslab-node.sh")
	if err != nil {
		t.Fatal(err)
	}
	text := string(blob)
	want := "install -m 0600 /dev/null \"$ENV_FILE\""
	if strings.Count(text, want) != 1 {
		t.Fatalf("expected exactly one %q in the node installer, found %d", want, strings.Count(text, want))
	}
	_, problems := secretFileProblems("node", strings.Replace(text, want, "true", 1))
	if len(problems) != 1 || !strings.Contains(problems[0], `chmod 600 "$ENV_FILE"`) && !strings.Contains(problems[0], "chmod 600 $ENV_FILE") {
		t.Errorf("problems after the creation was removed: %v", problems)
	}
}
