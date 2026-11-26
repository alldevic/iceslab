package main

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
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
	// amneziawg (3), naive (1), hysteria, mieru and the apt_update of node-env.sh
	// (the two updates are that one call now): a walk that found none proves nothing.
	if calls < 7 {
		t.Errorf("found %d apt-get calls under scripts/, the bootstraps have at least 7", calls)
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

// DPkg::Lock::Timeout does not cover /var/lib/apt/lists/lock: held by
// unattended-upgrades, `apt-get update` fails at once with rc 100 (measured on
// the stand). Every `apt-get update` therefore goes through apt_update, whose
// own body is the one place the call is made. The installer and every
// bootstrap are checked; the apt_update bodies are cut out first.
var aptUpdateFunc = regexp.MustCompile(`(?s)\napt_update\(\) \{.*?\n\}\n`)

func bareAptUpdates(script string) []string {
	var out []string
	for _, line := range logicalLines(aptUpdateFunc.ReplaceAllString("\n"+script, "\n")) {
		if aptCall.MatchString(line) && regexp.MustCompile(`\supdate(\s|$)`).MatchString(line) {
			out = append(out, strings.TrimSpace(line))
		}
	}
	return out
}

func TestNoBareAptGetUpdateInTheInstallerOrTheBootstraps(t *testing.T) {
	files := []string{installerPath}
	err := filepath.WalkDir("scripts", func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(path, ".sh") {
			files = append(files, path)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	updates := 0
	for _, path := range files {
		blob, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range bareAptUpdates(string(blob)) {
			t.Errorf("%s: apt-get update without the lists-lock retry (use apt_update): %s", path, line)
		}
		updates += strings.Count(string(blob), "\napt_update\n") + strings.Count(string(blob), "\n  apt_update\n")
	}
	if updates < 4 {
		t.Errorf("found %d apt_update calls, the installer (2), naive and amneziawg have 4", updates)
	}
}

func TestTheBareUpdateCheckCatchesABareUpdateButNotTheHelper(t *testing.T) {
	bare := "x\n\"${APT_ENV[@]}\" apt-get \"${APT_OPTS[@]}\" update -y\nDEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 update\n"
	if got := bareAptUpdates(bare); len(got) != 2 {
		t.Errorf("bare updates found: %q", got)
	}
	helper := "apt_update() {\n  out=$(apt-get -o X update -y 2>&1)\n}\napt_update\n"
	if got := bareAptUpdates(helper); len(got) != 0 {
		t.Errorf("the helper's own call read as bare: %q", got)
	}
}

// The helper run against a fake apt-get: update fails with the lists-lock
// message twice, then works. One log line per retry, rc 0, three calls; a
// failure that is not a lock comes back at once with its rc; a lock held past
// the budget comes back as the failure. Both copies (installer, node-env.sh).
func TestAptUpdateWaitsOutTheListsLock(t *testing.T) {
	bash := needBash(t)
	const lockMsg = "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 812 (apt-get)"
	helpers := map[string]string{
		"installer": scriptFunc(t, installerPath, "apt_update") + "APT_ENV=(env X=1)\nAPT_OPTS=(-o DPkg::Lock::Timeout=300)\n",
		"node-env":  scriptFunc(t, "scripts/lib/node-env.sh", "apt_update"),
	}
	for name, helper := range helpers {
		for _, c := range []struct {
			label    string
			failures int
			msg      string
			rc       int
			budget   string
			wantRC   int
			wantCall int
			wantWait int
		}{
			{"lock twice then fine", 2, lockMsg, 100, "", 0, 3, 2},
			{"other failure at once", 5, "E: Failed to fetch http://x  404", 100, "", 100, 1, 0},
			{"lock outlasts the budget", 99, lockMsg, 100, "0", 100, 1, 0},
		} {
			dir := t.TempDir()
			count := filepath.Join(dir, "count")
			bin := stubs(t, map[string]string{
				"apt-get": `n=$(cat '` + count + `' 2>/dev/null || echo 0); n=$((n+1)); echo $n >'` + count + `'
echo "apt-get $*" >>'` + count + `.calls'
if [ $n -le ` + strconv.Itoa(c.failures) + ` ]; then echo '` + c.msg + `' >&2; exit ` + strconv.Itoa(c.rc) + `; fi
echo 'Reading package lists...'
`,
				"env": `shift; exec "$@"` + "\n",
			})
			prog := "set -euo pipefail\nAPT_LOCK_RETRY_SECS=0\n"
			if c.budget != "" {
				prog += "APT_LOCK_WAIT_SECS=" + c.budget + "\n"
			}
			prog += helper + "rc=0\napt_update || rc=$?\necho \"RC=$rc\"\n"
			cmd := exec.Command(bash, "-c", prog)
			cmd.Env = []string{"PATH=" + bin + ":/usr/bin:/bin"}
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("%s/%s: %v\n%s", name, c.label, err, out)
			}
			calls, _ := os.ReadFile(count + ".calls")
			if !strings.Contains(string(out), "RC="+strconv.Itoa(c.wantRC)+"\n") ||
				strings.Count(string(calls), "update -y") != c.wantCall ||
				strings.Count(string(out), "apt is locked by another process, waiting: E: Could not get lock") != c.wantWait {
				t.Errorf("%s/%s: want rc %d, %d calls, %d retry lines:\n%s\ncalls:\n%s", name, c.label, c.wantRC, c.wantCall, c.wantWait, out, calls)
			}
		}
	}
}
