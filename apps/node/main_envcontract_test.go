package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// repoPath resolves a path relative to the repository root. The node module's
// root is apps/node and the installer lives outside it, so there is no import
// to reach for. Same walk as tune_script_test.go, which cannot be shared: it
// belongs to another package.
func repoPath(t *testing.T, rel string) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "scripts", "install-iceslab-node.sh")); err == nil {
			p := filepath.Join(dir, rel)
			if _, err := os.Stat(p); err != nil {
				t.Fatalf("repository found at %s but %s is missing: %v", dir, rel, err)
			}
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("could not find the repository root above %s", dir)
	return ""
}

// The env file the installer writes, against the env the agent reads.
//
// `install-iceslab-node.sh` composes /etc/iceslab-node/env out of a handful of
// heredocs and appends, and the systemd unit hands that file to the agent. The
// two sides name their keys independently, and a name that does not line up
// fails in the quietest way this repo has: the setting is simply absent. The
// agent takes its default, the node comes up, /healthz is green, and the thing
// the operator asked for is not happening.
//
// Two were found this way when the check was first written. NAIVE_BINARY was a
// half-finished rename — the agent had moved to CADDY_NAIVE_BIN and
// NAIVE_CONFIG still matched, so nothing looked wrong. REALISTIC_FALLBACK was
// not a naming slip at all: it was a probe-resistance toggle the panel showed
// as enabled on a node where nothing read it, while the feature itself worked
// per profile under `realityFallbackUpstream`. Two controls under one name,
// one dead — the toggle and the flag were removed instead of excused, so the
// exception list below is empty and meant to stay that way.

var envKeysWritten = regexp.MustCompile(`(?s)cat >>? "\$ENV_FILE" <<'?EOF'?\n(.*?)\nEOF`)
var envKeyLine = regexp.MustCompile(`(?m)^([A-Z][A-Z0-9_]{2,})=`)
var envKeyEcho = regexp.MustCompile(`echo "([A-Z][A-Z0-9_]{2,})=[^"]*"\s*>>\s*"\$ENV_FILE"`)
var goEnvRead = regexp.MustCompile(`(?:os\.Getenv|getenv|getenvInt)\("([A-Z][A-Z0-9_]{2,})"`)

// Keys the installer writes that the agent knowingly does not read yet, each
// with the reason. An entry here is a promise the panel makes and the node does
// not keep, so the list is meant to shrink and never to grow quietly. Empty is
// the correct state; the one entry it ever held was removed by deleting the
// toggle rather than by explaining it.
var knownUnread = map[string]string{}

func TestEveryKeyTheInstallerWritesIsOneTheAgentReads(t *testing.T) {
	installer, err := os.ReadFile(repoPath(t, "scripts/install-iceslab-node.sh"))
	if err != nil {
		t.Fatalf("read installer: %v", err)
	}

	written := map[string]bool{}
	for _, block := range envKeysWritten.FindAllStringSubmatch(string(installer), -1) {
		for _, k := range envKeyLine.FindAllStringSubmatch(block[1], -1) {
			written[k[1]] = true
		}
	}
	for _, k := range envKeyEcho.FindAllStringSubmatch(string(installer), -1) {
		written[k[1]] = true
	}
	// Control: the extraction has to find the file's own shape. NODE_PAYLOAD is
	// the first line of the first heredoc and the whole point of the file.
	if !written["NODE_PAYLOAD"] || len(written) < 20 {
		t.Fatalf("parsed only %d keys out of the installer's env file and NODE_PAYLOAD=%v; "+
			"the heredocs were reshaped and this comparison is empty", len(written), written["NODE_PAYLOAD"])
	}

	read := map[string]bool{}
	root := repoPath(t, "apps/node")
	walkGo(t, root, func(src string) {
		for _, m := range goEnvRead.FindAllStringSubmatch(src, -1) {
			read[m[1]] = true
		}
	})
	if len(read) < 30 {
		t.Fatalf("found only %d env reads in the agent; the scan is not seeing the source", len(read))
	}

	var unread, staleException []string
	for k := range written {
		if read[k] {
			if _, listed := knownUnread[k]; listed {
				staleException = append(staleException, k)
			}
			continue
		}
		if _, ok := knownUnread[k]; ok {
			continue
		}
		unread = append(unread, k)
	}
	sort.Strings(unread)
	sort.Strings(staleException)

	if len(unread) > 0 {
		t.Errorf("the installer writes these into /etc/iceslab-node/env and nothing in the agent reads them, "+
			"so the setting is silently absent on every node: %s", strings.Join(unread, ", "))
	}
	// The exception list must not outlive the problem: a key that is read now
	// should stop being excused, or the next real one hides behind it.
	if len(staleException) > 0 {
		t.Errorf("these are listed as knowingly unread but the agent does read them now; drop them from knownUnread: %s",
			strings.Join(staleException, ", "))
	}
	// ...and an excuse for a key the installer no longer writes at all is just
	// as stale, and would sit here silently: nothing above ever looks at it.
	var forgotten []string
	for k := range knownUnread {
		if !written[k] {
			forgotten = append(forgotten, k)
		}
	}
	sort.Strings(forgotten)
	if len(forgotten) > 0 {
		t.Errorf("knownUnread excuses keys the installer does not write any more; drop them: %s",
			strings.Join(forgotten, ", "))
	}
}

func walkGo(t *testing.T, dir string, visit func(string)) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	for _, e := range entries {
		p := dir + string(os.PathSeparator) + e.Name()
		if e.IsDir() {
			if e.Name() == "vendor" || e.Name() == ".git" {
				continue
			}
			walkGo(t, p, visit)
			continue
		}
		if !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		visit(string(b))
	}
}
