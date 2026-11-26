package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// 5.4 (f18-14): a bootstrap that calls apt-get bare fails with exit 100 while
// unattended-upgrades holds the dpkg lock, and when the panel adds a core to a
// live node nothing waits for it first (wait_for_apt is the installer's). Every
// apt-get of every script under apps/node/scripts carries apt's own wait
// (DPkg::Lock::Timeout) and runs non-interactively. The directory is walked,
// not a list of files, so the bootstraps of later cores (mtproxy, wireguard)
// fall under it on their own.
//
// ⚠ Reads files outside the package: `go test -count=1` locally.

var (
	aptQuoted = regexp.MustCompile(`"[^"]*"|'[^']*'`)
	aptCall   = regexp.MustCompile(`(^|[\s;&|(])apt-get\s`)
)

// logicalLines is the script as the shell reads it: a line ending in a
// backslash is one with the next, comments are gone, and so is everything in
// quotes (a message that names apt-get is not a call of it).
func logicalLines(s string) []string {
	var out []string
	var cur string
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "#") && cur == "" {
			continue
		}
		if strings.HasSuffix(line, "\\") {
			cur += strings.TrimSuffix(line, "\\") + " "
			continue
		}
		if joined := cur + line; strings.TrimSpace(joined) != "" {
			out = append(out, aptQuoted.ReplaceAllString(joined, `""`))
		}
		cur = ""
	}
	return out
}

func TestEveryAptGetInTheBootstrapsWaitsForTheDpkgLock(t *testing.T) {
	calls := 0
	err := filepath.WalkDir("scripts", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".sh") {
			return err
		}
		blob, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, line := range logicalLines(string(blob)) {
			if !aptCall.MatchString(line) {
				continue
			}
			calls++
			if !strings.Contains(line, "-o DPkg::Lock::Timeout=") {
				t.Errorf("%s: apt-get does not wait for the dpkg lock: %s", path, strings.TrimSpace(line))
			}
			if !strings.Contains(line, "DEBIAN_FRONTEND=noninteractive") {
				t.Errorf("%s: apt-get may ask a question: %s", path, strings.TrimSpace(line))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// The eight of amneziawg (4), naive (2), hysteria and mieru: a walk that
	// found none proves nothing.
	if calls < 8 {
		t.Errorf("found %d apt-get calls under scripts/, the bootstraps have at least 8", calls)
	}
}

func TestTheAptCheckSeesABareCallAndIgnoresAMessage(t *testing.T) {
	bare := logicalLines("  apt-get install -f -y\n")
	msg := logicalLines("warn \"running apt-get install -f to fix deps\"\n# apt-get update\n")
	cont := logicalLines("DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 purge -y $P \\\n  || fail \"remove them (apt-get purge)\"\n")
	if len(bare) != 1 || !aptCall.MatchString(bare[0]) || strings.Contains(bare[0], "DPkg::Lock::Timeout") {
		t.Errorf("a bare call: %q", bare)
	}
	for _, l := range msg {
		if aptCall.MatchString(l) {
			t.Errorf("a message or comment read as a call: %q", l)
		}
	}
	if len(cont) != 1 || !aptCall.MatchString(cont[0]) || !strings.Contains(cont[0], "DPkg::Lock::Timeout=") {
		t.Errorf("a continued call: %q", cont)
	}
}
