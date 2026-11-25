//go:build linux

package metrics

import (
	"math"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Measured before writing: `go test ./... -coverpkg=./internal/metrics` reported
// 0.0% for Collect and for every /proc reader in the package. Nothing ran them.
//
// Two of the numbers here are not decoration. TotalRAMBytes is read once at
// startup to turn a "percent of RAM" core-memory ceiling into the byte figure
// the subprocess watchdog compares RSS against - so a total that is 1024x too
// small (the classic /proc kB-vs-bytes slip) arms a ceiling of a few megabytes
// and the watchdog restarts a healthy core forever. And CPU usage is what an
// operator reads to decide a node is overloaded.
//
// The readers open /proc by fixed path, so these ask the host rather than a
// fixture: the invariants below are ones any Linux box satisfies, and each is
// picked so that a plausible defect breaks it.

const MiB = 1 << 20

func TestMemoryIsReadInBytesNotKilobytes(t *testing.T) {
	m, err := readMemInfo()
	if err != nil {
		t.Fatalf("readMemInfo: %v", err)
	}

	// /proc/meminfo is in kB. Dropping the conversion turns a 4 GB host into a
	// 4 MB one, which is below any machine that can run this agent - so this
	// bound catches the slip without hard-coding the size of the test box.
	if m.TotalBytes < 256*MiB {
		t.Errorf("TotalBytes = %d (%.1f MiB): no host running a node has that little RAM; "+
			"the kB->bytes conversion is the usual reason", m.TotalBytes, float64(m.TotalBytes)/MiB)
	}
	if m.AvailableBytes > m.TotalBytes {
		t.Errorf("available %d > total %d", m.AvailableBytes, m.TotalBytes)
	}
	if m.UsedBytes != m.TotalBytes-m.AvailableBytes {
		t.Errorf("used %d != total %d - available %d", m.UsedBytes, m.TotalBytes, m.AvailableBytes)
	}
	want := float64(m.UsedBytes) / float64(m.TotalBytes) * 100
	if math.Abs(m.UsedPercent-want) > 0.01 {
		t.Errorf("UsedPercent = %.2f, want %.2f computed from the same two numbers", m.UsedPercent, want)
	}
	if m.UsedPercent < 0 || m.UsedPercent > 100 {
		t.Errorf("UsedPercent = %.2f, outside 0..100", m.UsedPercent)
	}
}

// The watchdog ceiling is computed from this one call, and it is a different
// call path from Collect(). A zero here must be an error, not a number: a
// ceiling of "50% of 0" would either disarm the watchdog silently or restart
// the core immediately, depending on which way the caller rounds.
func TestTotalRAMBytesAgreesWithTheSnapshot(t *testing.T) {
	total, err := TotalRAMBytes()
	if err != nil {
		t.Fatalf("TotalRAMBytes: %v", err)
	}
	m, err := readMemInfo()
	if err != nil {
		t.Fatalf("readMemInfo: %v", err)
	}
	if total != m.TotalBytes {
		t.Errorf("TotalRAMBytes = %d but the snapshot says %d; the watchdog ceiling and the "+
			"dashboard would be computed from different numbers", total, m.TotalBytes)
	}
	// The "total reported as 0 is an error, not a number" branch cannot be
	// reached on a host that has RAM, so it is deliberately not asserted here:
	// a check that can never fail is not a check.
}

// The first Collect has no previous snapshot to diff against, so it must report
// 0 rather than invent a figure. The second one, taken after every core has
// been busy, must report a high one - which is also how the direction of the
// idle/total ratio gets checked: inverted, a fully busy interval reads as
// nearly idle.
func TestCPUPercentNeedsTwoSamplesAndPointsTheRightWay(t *testing.T) {
	c := New("/")

	first, err := c.Collect()
	if err != nil {
		t.Fatalf("first Collect: %v", err)
	}
	if first.CPU.UsagePercent != 0 {
		t.Errorf("first sample reported %.2f%% CPU; with nothing to diff against the only "+
			"honest answer is 0", first.CPU.UsagePercent)
	}
	if first.CPU.Cores != runtime.NumCPU() {
		t.Errorf("Cores = %d, want %d", first.CPU.Cores, runtime.NumCPU())
	}

	burnAllCores(300 * time.Millisecond)

	second, err := c.Collect()
	if err != nil {
		t.Fatalf("second Collect: %v", err)
	}
	if second.CPU.UsagePercent <= 25 {
		t.Errorf("CPU usage over an interval where every core was spinning came out at %.2f%%; "+
			"either the previous sample was not kept or idle and busy are the wrong way round",
			second.CPU.UsagePercent)
	}
	if second.CPU.UsagePercent > 100 {
		t.Errorf("CPU usage = %.2f%%, above the clamp", second.CPU.UsagePercent)
	}
}

func burnAllCores(d time.Duration) {
	var wg sync.WaitGroup
	deadline := time.Now().Add(d)
	for i := 0; i < runtime.NumCPU(); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			x := 0
			for time.Now().Before(deadline) {
				for j := 0; j < 1_000_000; j++ {
					x += j
				}
			}
			_ = x
		}()
	}
	wg.Wait()
}

func TestDiskIsReportedForThePathThatWasAsked(t *testing.T) {
	d, err := statDisk("/")
	if err != nil {
		t.Fatalf("statDisk(/): %v", err)
	}
	if d.Path != "/" {
		t.Errorf("Path = %q, want the path that was asked for", d.Path)
	}
	if d.TotalBytes == 0 {
		t.Error("TotalBytes = 0 for the root filesystem")
	}
	if d.UsedBytes > d.TotalBytes {
		t.Errorf("used %d > total %d", d.UsedBytes, d.TotalBytes)
	}
	want := float64(d.UsedBytes) / float64(d.TotalBytes) * 100
	if math.Abs(d.UsedPercent-want) > 0.01 {
		t.Errorf("UsedPercent = %.2f, want %.2f", d.UsedPercent, want)
	}
}

// A path that is not there is an operator's typo in the agent config, not a
// reason to stop reporting. The error names the path so the message says which
// one, and the caller still gets the rest of the snapshot.
func TestAMissingDiskPathDoesNotBlankTheSnapshot(t *testing.T) {
	d, err := statDisk("/definitely/not/a/mount/point")
	if err == nil {
		t.Fatal("statDisk on a missing path returned no error")
	}
	if d.Path != "/definitely/not/a/mount/point" {
		t.Errorf("Path = %q on the failing result; without it the error does not say which path", d.Path)
	}

	m, err := New("/definitely/not/a/mount/point").Collect()
	if err != nil {
		t.Fatalf("Collect: a failing disk section must not fail the whole snapshot: %v", err)
	}
	if m.Memory.TotalBytes == 0 {
		t.Error("memory section is empty; one broken section took the others with it")
	}
	if m.Disk.TotalBytes != 0 {
		t.Errorf("disk section reports %d bytes for a path that does not exist", m.Disk.TotalBytes)
	}
}

func TestCollectorDefaultsToTheRootFilesystem(t *testing.T) {
	m, err := New("").Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if m.Disk.Path != "/" {
		t.Errorf("disk path = %q, want / when the caller named none", m.Disk.Path)
	}
	if m.UptimeSeconds < 0 {
		t.Errorf("UptimeSeconds = %d", m.UptimeSeconds)
	}
	if m.CollectedAt.IsZero() {
		t.Error("CollectedAt is zero: the panel uses it to tell a stale sample from a fresh one")
	}
}

// The three averages must be the first three fields of /proc/loadavg, in that
// order. The fourth field is "running/total" (e.g. "2/1234"), which parses as
// 0 and would show a permanently idle fleet - and a shift by one is otherwise
// invisible, since every value stays a plausible number.
//
// Compared against the file itself rather than against numbers written here:
// the file is the source of truth, and a fixture would just be this test's
// opinion of it. Read twice around the call because the kernel refreshes it
// every few seconds; either snapshot may legitimately be the one that was seen.
func TestLoadAverageReadsTheFirstThreeFields(t *testing.T) {
	before := rawLoadAvg(t)
	l1, l5, l15, err := readLoadAvg()
	if err != nil {
		t.Fatalf("readLoadAvg: %v", err)
	}
	after := rawLoadAvg(t)

	if !matchesLoadAvg(before, l1, l5, l15) && !matchesLoadAvg(after, l1, l5, l15) {
		t.Errorf("readLoadAvg returned %.2f %.2f %.2f, which is not the first three fields of "+
			"/proc/loadavg (%v / %v)", l1, l5, l15, before, after)
	}
}

func rawLoadAvg(t *testing.T) []float64 {
	t.Helper()
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		t.Fatalf("read /proc/loadavg: %v", err)
	}
	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		t.Fatalf("/proc/loadavg has an unexpected shape: %q", string(data))
	}
	out := make([]float64, 3)
	for i := 0; i < 3; i++ {
		v, err := strconv.ParseFloat(fields[i], 64)
		if err != nil {
			t.Fatalf("/proc/loadavg field %d is not a number: %q", i, fields[i])
		}
		out[i] = v
	}
	return out
}

func matchesLoadAvg(want []float64, l1, l5, l15 float64) bool {
	return want[0] == l1 && want[1] == l5 && want[2] == l15
}
