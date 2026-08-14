//go:build linux

package subprocess

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// readRSSBytes returns the resident set size of `pid` in bytes, read from
// /proc/<pid>/statm. Field 2 of that file is the resident page count, so the
// value is pages * page size.
//
// statm rather than /proc/<pid>/status: it is a single short line of numbers,
// so parsing costs nothing and there is no locale/format surprise. RSS rather
// than VmSize because virtual size counts memory the kernel never backed, and
// the thing we're defending against (a core steadily eating the box until the
// OOM killer fires) shows up in RSS.
//
// Caveat worth knowing: RSS includes shared pages, so a core sharing libraries
// is counted slightly generously. Harmless here - the ceiling sits high and is
// meant to catch runaway growth, not to bill memory precisely.
func readRSSBytes(pid int) (uint64, error) {
	path := fmt.Sprintf("/proc/%d/statm", pid)
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(data))
	if len(fields) < 2 {
		return 0, fmt.Errorf("%s: unexpected shape %q", path, string(data))
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s: resident field %q: %w", path, fields[1], err)
	}
	return pages * uint64(os.Getpagesize()), nil
}
