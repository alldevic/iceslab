package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// bootstrap-mtprotoproxy.sh end to end, on a fake root: its paths moved under
// the test's directory, root and chown stubbed, curl serving a tarball built
// here. Milestone 8.2: the sha256 is judged BEFORE anything is unpacked, a
// mismatch installs nothing, --remove takes the env block and the tree out,
// and a node without a fast AES backend does not get the engine.
//
// ⚠ Reads files outside the package: `go test -count=1` locally. Needs bash,
// tar and a python3.

func mppTarball(t *testing.T, py string) []byte {
	t.Helper()
	var raw bytes.Buffer
	gz := gzip.NewWriter(&raw)
	tw := tar.NewWriter(gz)
	// The directory inside is named after the tag, as GitHub's archive does.
	for _, f := range []struct{ name, body string }{{"mtprotoproxy-9.9.9/mtprotoproxy.py", py}, {"mtprotoproxy-9.9.9/config.py", "PORT = 1\n"}} {
		if err := tw.WriteHeader(&tar.Header{Name: f.name, Mode: 0o644, Size: int64(len(f.body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(f.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return raw.Bytes()
}

// A stand-in for the real patch, which is written against upstream's tag and
// would not apply to the one-line tree built here: the same two additions, on
// the line mppTarball callers use. mppHalfPatch adds only the first.
const mppFixturePatch = `--- a/mtprotoproxy.py
+++ b/mtprotoproxy.py
@@ -1 +1,3 @@
 print('ok')
+TG_EXTRA_DATACENTERS_V4 = {203: "x"}
+def update_dropped(): pass
`

const mppHalfPatch = `--- a/mtprotoproxy.py
+++ b/mtprotoproxy.py
@@ -1 +1,2 @@
 print('ok')
+TG_EXTRA_DATACENTERS_V4 = {203: "x"}
`

// Written against lines the tree does not have: a pin that moved them.
const mppStalePatch = `--- a/mtprotoproxy.py
+++ b/mtprotoproxy.py
@@ -1,3 +1,4 @@
 import asyncio
-DCS = 5
+DCS = 6
 print('x')
+TG_EXTRA_DATACENTERS_V4 = {}
`

type mppRun struct {
	dir, env, script string
}

// newMppRun stages the script and its library. fastAES false makes the stub
// python3 report neither cryptography nor pycryptodome; the script's apt-get
// path is moved to nothing, so "install it" is what cannot happen.
func newMppRun(t *testing.T, tarball []byte, fastAES bool) mppRun {
	t.Helper()
	s, _ := newCoreSrc(t, panelPayload(t, "", ""))
	bin := filepath.Join(s.dir, "bin")
	realPy, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("no python3 on this machine")
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	src := filepath.Join(s.dir, "src.tar.gz")
	if err := os.WriteFile(src, tarball, 0o644); err != nil {
		t.Fatal(err)
	}
	write("curl", `echo "curl $*" >>"$CALLS"
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
cp "$SRC_TARBALL" "$out"
`)
	write("chown", "exit 0\n")
	aes := "exit 1"
	if fastAES {
		aes = "exit 0"
	}
	write("python3", `case "$*" in
  *"import cryptography"*|*"import Crypto"*) `+aes+` ;;
esac
exec `+realPy+` "$@"
`)
	// tar, sha256sum, awk, mktemp, mv, rm, mkdir, chmod, pgrep, sed, grep from the system.
	scripts := filepath.Join(s.dir, "scripts")
	if err := os.MkdirAll(filepath.Join(scripts, "lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	lib, _ := os.ReadFile(filepath.Join("scripts", "lib", "node-env.sh"))
	if err := os.WriteFile(filepath.Join(scripts, "lib", "node-env.sh"), lib, 0o644); err != nil {
		t.Fatal(err)
	}
	body := readScript(t, "bootstrap-mtprotoproxy.sh")
	body = regexp.MustCompile(`(?m)^(\s*)\[\[ \$EUID -eq 0 \]\] \|\| fail .*$`).ReplaceAllString(body, "${1}true")
	// The real apt-get of this machine is not for a test to run.
	body = strings.ReplaceAll(body, "/usr/bin/apt-get", s.dir+"/no-apt-get")
	body = strings.ReplaceAll(body, "/opt/mtprotoproxy", s.dir+"/opt/mtprotoproxy")
	body = strings.ReplaceAll(body, "/etc/mtprotoproxy", s.dir+"/etc/mtprotoproxy")
	path := filepath.Join(scripts, "bootstrap-mtprotoproxy.sh")
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(s.dir+"/opt", 0o755); err != nil {
		t.Fatal(err)
	}
	r := mppRun{dir: s.dir, env: filepath.Join(s.dir, "env"), script: path}
	r.setPatch(t, mppFixturePatch)
	return r
}

func (r mppRun) setPatch(t *testing.T, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(filepath.Dir(r.script), "mtprotoproxy-cdn-datacenters.patch"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (r mppRun) run(t *testing.T, sha string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command(needBash(t), append([]string{r.script}, args...)...)
	cmd.Env = []string{
		"PATH=" + filepath.Join(r.dir, "bin") + ":/usr/bin:/bin", "HOME=" + r.dir,
		"CALLS=" + filepath.Join(r.dir, "calls"), "SRC_TARBALL=" + filepath.Join(r.dir, "src.tar.gz"),
		"ICESLAB_NODE_ENV=" + r.env, "ICESLAB_CORE_SOURCE=github",
		"MTPROTOPROXY_VERSION=9.9.9", "MTPROTOPROXY_SHA256=" + sha,
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (r mppRun) envText(t *testing.T) string {
	t.Helper()
	b, _ := os.ReadFile(r.env)
	return string(b)
}

func TestMtprotoproxyInstallsThePinnedTreeAndWiresIt(t *testing.T) {
	tb := mppTarball(t, "print('ok')\n")
	r := newMppRun(t, tb, true)
	out, err := r.run(t, shaOf(string(tb)))
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if _, err := os.Stat(r.dir + "/opt/mtprotoproxy/mtprotoproxy.py"); err != nil {
		t.Errorf("the script is not at its path (the tag directory must be stripped): %v\n%s", err, out)
	}
	if st, err := os.Stat(r.dir + "/etc/mtprotoproxy"); err != nil || st.Mode().Perm() != 0o700 {
		t.Errorf("the config dir: %v %v", st, err)
	}
	if _, err := os.Stat(r.dir + "/opt/mtprotoproxy/__pycache__"); err == nil {
		t.Error("the smoke test left bytecode in the tree")
	}
	env := r.envText(t)
	if !strings.Contains(env, "iceslab-node env:mtprotoproxy") || !strings.Contains(env, "MTPROTOPROXY_SCRIPT="+r.dir+"/opt/mtprotoproxy/mtprotoproxy.py") {
		t.Errorf("the env block is not written:\n%s", env)
	}
	if !strings.Contains(out, "opens no firewall port") {
		t.Errorf("the operator is not told the port stays closed:\n%s", out)
	}
}

func TestMtprotoproxyChecksTheSumBeforeUnpacking(t *testing.T) {
	r := newMppRun(t, mppTarball(t, "print('evil')\n"), true)
	out, err := r.run(t, shaOf("something else"))
	if err == nil || !strings.Contains(out, "checksum mismatch") {
		t.Fatalf("a wrong archive was accepted: %v\n%s", err, out)
	}
	if _, err := os.Stat(r.dir + "/opt/mtprotoproxy"); err == nil {
		t.Error("a tree is installed after a checksum mismatch")
	}
	if strings.Contains(r.envText(t), "iceslab-node env:mtprotoproxy") {
		t.Error("the engine is wired in after a checksum mismatch")
	}
}

func TestMtprotoproxyWithoutAFastAESBackendIsNotInstalled(t *testing.T) {
	tb := mppTarball(t, "print('ok')\n")
	r := newMppRun(t, tb, false)
	out, err := r.run(t, shaOf(string(tb)))
	if err == nil || !strings.Contains(out, "no apt-get") {
		t.Fatalf("want the install of python3-cryptography to be tried, and to fail the script: %v\n%s", err, out)
	}
	if _, err := os.Stat(r.dir + "/opt/mtprotoproxy"); err == nil {
		t.Error("an engine the agent would refuse to start was installed")
	}
}

func TestMtprotoproxyRemoveTakesTheBlockAndTheTreeOut(t *testing.T) {
	tb := mppTarball(t, "print('ok')\n")
	r := newMppRun(t, tb, true)
	if out, err := r.run(t, shaOf(string(tb))); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if err := os.WriteFile(r.dir+"/etc/mtprotoproxy/config.py", []byte("USERS = {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if out, err := r.run(t, shaOf(string(tb)), "--remove"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if env := r.envText(t); strings.Contains(env, "mtprotoproxy") || !strings.Contains(env, "NODE_PAYLOAD=") {
		t.Errorf("--remove left the block, or took the payload:\n%s", env)
	}
	for _, p := range []string{"/opt/mtprotoproxy", "/etc/mtprotoproxy/config.py"} {
		if _, err := os.Stat(r.dir + p); err == nil {
			t.Errorf("%s is still there after --remove", p)
		}
	}
	if _, err := os.Stat(r.dir + "/etc/mtprotoproxy"); err != nil {
		t.Error("the config dir (which the agent's unit lists as writable) went with it")
	}
}

func TestMtprotoproxyPatchesTheTreeAndWritesTheVersionLast(t *testing.T) {
	tb := mppTarball(t, "print('ok')\n")
	r := newMppRun(t, tb, true)
	out, err := r.run(t, shaOf(string(tb)))
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	py, _ := os.ReadFile(r.dir + "/opt/mtprotoproxy/mtprotoproxy.py")
	if !strings.Contains(string(py), "TG_EXTRA_DATACENTERS_V4") || !strings.Contains(string(py), "def update_dropped") {
		t.Errorf("the installed script is not patched:\n%s", py)
	}
	v, err := os.ReadFile(r.dir + "/opt/mtprotoproxy/.iceslab-version")
	if err != nil || strings.TrimSpace(string(v)) != "9.9.9" {
		t.Errorf("the version file: %q, %v", v, err)
	}
	// A rerun over the installed tree is a plain reinstall.
	if out, err := r.run(t, shaOf(string(tb))); err != nil {
		t.Fatalf("rerun: %v\n%s", err, out)
	}
	// --remove takes the version file with the directory.
	if out, err := r.run(t, shaOf(string(tb)), "--remove"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if _, err := os.Stat(r.dir + "/opt/mtprotoproxy/.iceslab-version"); err == nil {
		t.Error("the version file outlived --remove")
	}
}

func TestMtprotoproxyStopsWhenThePatchDoesNotApplyOrAppliesByHalf(t *testing.T) {
	cases := map[string]struct{ tarPy, patch, want string }{
		"does not apply": {"print('ok')\n", mppStalePatch, "did not apply"},
		"half applied":   {"print('ok')\n", mppHalfPatch, "dropped-connection counter"},
		"missing":        {"print('ok')\n", "", "missing"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			tb := mppTarball(t, c.tarPy)
			r := newMppRun(t, tb, true)
			if c.patch == "" {
				if err := os.Remove(filepath.Join(filepath.Dir(r.script), "mtprotoproxy-cdn-datacenters.patch")); err != nil {
					t.Fatal(err)
				}
			} else {
				r.setPatch(t, c.patch)
			}
			out, err := r.run(t, shaOf(string(tb)))
			if err == nil || !strings.Contains(out, c.want) {
				t.Fatalf("want a stop mentioning %q: %v\n%s", c.want, err, out)
			}
			if _, err := os.Stat(r.dir + "/opt/mtprotoproxy"); err == nil {
				t.Error("a tree is installed although the patch did not land (so is a version file)")
			}
			if strings.Contains(r.envText(t), "iceslab-node env:mtprotoproxy") {
				t.Error("the engine is wired in after a failed patch")
			}
		})
	}
}

// The script as shipped: it names the patch next to it, the patch is there and
// is the real diff (both halves), and the patch step sits after the checksum
// and before the compile check and the version file.
func TestMtprotoproxyScriptShipsItsPatch(t *testing.T) {
	body := readScript(t, "bootstrap-mtprotoproxy.sh")
	if !strings.Contains(body, "mtprotoproxy-cdn-datacenters.patch") {
		t.Error("the script does not name its patch")
	}
	patch, err := os.ReadFile(filepath.Join("scripts", "mtprotoproxy-cdn-datacenters.patch"))
	if err != nil {
		t.Fatalf("the patch file: %v", err)
	}
	for _, want := range []string{"TG_EXTRA_DATACENTERS_V4", "def update_dropped"} {
		if !strings.Contains(string(patch), want) {
			t.Errorf("the patch does not add %s", want)
		}
		if !strings.Contains(body, "grep -q "+strings.TrimPrefix(want, "def ")) && !strings.Contains(body, `grep -q "`+want+`"`) {
			t.Errorf("the script does not check for %s in the result", want)
		}
	}
	at := func(s string) int { return strings.Index(body, s) }
	sum, patchAt, compile, version := at("Checksum OK"), at("patch -p1"), at("compile(open("), at(".iceslab-version")
	if !(sum >= 0 && sum < patchAt && patchAt < compile && compile < version) {
		t.Errorf("order wrong: checksum %d, patch %d, compile %d, version file %d", sum, patchAt, compile, version)
	}
}
