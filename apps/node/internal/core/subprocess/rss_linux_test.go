//go:build linux

package subprocess

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

// readRSSBytes is the sampler the memory watchdog compares against the
// ceiling, and it is half of a number the other half of which (TotalRAMBytes)
// already has a test. `go test -coverpkg` reported 0.0% here: nothing had ever
// called it, in a function whose two plausible mistakes are silent.
//
//   - reading field 1 of statm instead of field 2 gives VmSize, which for a Go
//     process is several times RSS: the ceiling then fires on a core that is
//     using a fraction of what the operator allowed, and every firing drops
//     every live connection on the node.
//   - forgetting the page-size multiply gives a number ~4096x too small, so
//     the ceiling never fires and the watchdog quietly does nothing while the
//     box heads for the OOM killer.
//
// Both produce a plausible-looking uint64. So the check is against a second,
// independent view the kernel publishes of the same quantity: VmRSS in
// /proc/self/status, which is a different file in a different format.

// vmRSSBytes reads VmRSS from /proc/self/status, in bytes: the kernel's other
// answer to the same question, in a different file and a different format.
func vmRSSBytes(t *testing.T) uint64 {
	t.Helper()
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		t.Skipf("no /proc/self/status: %v", err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 3 || f[2] != "kB" {
			t.Fatalf("VmRSS line in an unexpected shape: %q", line)
		}
		kb, err := strconv.ParseUint(f[1], 10, 64)
		if err != nil {
			t.Fatalf("VmRSS value %q: %v", f[1], err)
		}
		return kb * 1024
	}
	t.Fatal("no VmRSS in /proc/self/status")
	return 0
}

func TestReadRSSBytes_AgreesWithVmRSS(t *testing.T) {
	got, err := readRSSBytes(os.Getpid())
	if err != nil {
		t.Fatalf("readRSSBytes(self): %v", err)
	}
	want := vmRSSBytes(t)

	// The two are sampled a few microseconds apart on a live, allocating
	// process, so they are not required to be equal — only to be the same
	// quantity. A tenth is far tighter than either mistake above (4x and
	// 4096x) and far looser than ordinary drift between two reads.
	lo, hi := want/10*9, want/10*11
	if got < lo || got > hi {
		t.Errorf("readRSSBytes = %d bytes, /proc/self/status VmRSS = %d bytes; "+
			"these are meant to be the same number. Field 1 of statm (VmSize) or a "+
			"missing page-size multiply both land here.", got, want)
	}
}

// A read that fails must SAY so. Returning (0, nil) would read as "0 bytes
// resident", i.e. permanently under any ceiling — a watchdog that reports
// itself as working while enforcing nothing. That is what the non-linux
// fallback's comment is about, and it applies just as much when the pid is
// simply gone.
func TestReadRSSBytes_MissingProcessIsAnErrorNotZero(t *testing.T) {
	// A pid above the configured maximum cannot exist.
	_, err := readRSSBytes(1 << 30)
	if err == nil {
		t.Error("readRSSBytes on a nonexistent pid returned no error; the watchdog would " +
			"read that as a process comfortably under its ceiling")
	}
}
