package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The shell-out every adapter owns a copy of.
//
// Eight packages define their own `defaultRunCmd`/`realRunCmd`, and all eight
// are the same three lines: exec.CommandContext, CombinedOutput, return. The
// choice inside them is not stylistic. Every caller logs `string(out)` when the
// command fails — `mita apply config: %w (%s)`, `ufw allow failed ... out`,
// `awg-quick up` — and a binary that refuses a config says why on STDERR. A
// copy that switched to `.Output()` would keep compiling, keep returning the
// same error, and leave the operator with "exit status 1" and nothing else,
// which on a node is the difference between a fixable config and a mystery.
//
// Eight copies of one decision, held together by nothing. Compared here at the
// source, because there is no shared symbol to test.

var runCmdBody = regexp.MustCompile(`(?s)func (?:default|real)RunCmd\([^)]*\)[^{]*\{(.*?)\n\}`)

func TestEveryAdapterShellsOutTheSameWay(t *testing.T) {
	root := repoPath(t, "apps/node")

	found := map[string]string{}
	var files []string
	collect(t, root, &files)

	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		for _, m := range runCmdBody.FindAllStringSubmatch(string(src), -1) {
			rel, _ := filepath.Rel(root, f)
			found[rel] = normalise(m[1])
		}
	}

	// Control: the regexp has to have found the copies. Eight is what there
	// are; fewer means the shape changed and this comparison is nearly empty.
	if len(found) < 8 {
		t.Fatalf("found only %d runCmd definitions (%v); the shape changed and this comparison is nearly empty",
			len(found), keysOf(found))
	}

	var wrong []string
	for file, body := range found {
		if !strings.Contains(body, "CombinedOutput()") {
			wrong = append(wrong, file+" does not use CombinedOutput, so a failing binary's reason is dropped")
		}
		if !strings.Contains(body, "exec.CommandContext(") {
			wrong = append(wrong, file+" does not honour the context, so a hung binary is never killed")
		}
	}
	sort.Strings(wrong)
	if len(wrong) > 0 {
		t.Errorf("the adapters no longer shell out the same way:\n  %s", strings.Join(wrong, "\n  "))
	}
}

func normalise(s string) string {
	out := []string{}
	for _, l := range strings.Split(s, "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "//") {
			continue
		}
		out = append(out, l)
	}
	return strings.Join(out, " ")
}

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func collect(t *testing.T, dir string, out *[]string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		if e.IsDir() {
			if e.Name() == "vendor" || e.Name() == ".git" || e.Name() == "generated" {
				continue
			}
			collect(t, p, out)
			continue
		}
		if strings.HasSuffix(e.Name(), ".go") && !strings.HasSuffix(e.Name(), "_test.go") {
			*out = append(*out, p)
		}
	}
}
