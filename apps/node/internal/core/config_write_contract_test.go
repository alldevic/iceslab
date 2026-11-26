package core_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// How every adapter puts its config on disk, asked of all of them at once.
//
// A core config is read by somebody else (the core itself, on start and on
// reload) while the agent is writing it. os.WriteFile truncates the
// destination and then writes into it, so for the length of that write the
// file is a prefix of the new config, and a write that dies partway leaves
// that prefix under the final name with the working config already gone.
// internal/atomicfile writes a temp file beside the destination, syncs it and
// renames it over.
//
// The observable difference is the inode: truncating in place keeps it, a
// rename replaces it. That is the property itself, not a proxy for it, and it
// needs no fault injection and no root.
//
// The rows are cases() of lifecycle_contract_test.go. How a row's config gets
// rewritten is its own `rewrite` (Start, when nil); an adapter that writes
// only with a binary says so in configNeedsBinary and is out of this file.

func inodeOf(t *testing.T, path string) uint64 {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		t.Skip("no inode on this platform")
	}
	return sys.Ino
}

// writeTwice brings the row's config onto disk and writes it again, returning
// the path. The second write carries a changed config where the adapter skips
// an unchanged one.
func writeTwice(t *testing.T, c adapterCase) (a core.CoreAdapter, cfgPath string, first, second uint64) {
	t.Helper()
	a, cfgPath = c.build(t, true)
	ctx := context.Background()
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	if err := a.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if c.rewrite != nil {
		c.rewrite(t, a, 1)
		first = inodeOf(t, cfgPath)
		c.rewrite(t, a, 2)
		return a, cfgPath, first, inodeOf(t, cfgPath)
	}
	first = inodeOf(t, cfgPath)
	if err := a.Start(ctx); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	return a, cfgPath, first, inodeOf(t, cfgPath)
}

func TestRewritingAConfigReplacesTheFileInsteadOfTruncatingIt(t *testing.T) {
	for _, c := range cases() {
		if c.configNeedsBinary != "" {
			continue
		}
		t.Run(c.name, func(t *testing.T) {
			_, _, first, second := writeTwice(t, c)
			if first == second {
				t.Errorf("the config was rewritten in place (inode %d both times): a core reloading "+
					"during that write reads a truncated file, and a write that dies partway leaves "+
					"one under the final name. Write through internal/atomicfile.", first)
			}
		})
	}
}

// The other half: a rename-based write leaves a temp file beside the
// destination if it fails, and atomicfile removes it on every error path.
func TestAConfigWriteLeavesNothingBesideTheConfig(t *testing.T) {
	for _, c := range cases() {
		if c.configNeedsBinary != "" {
			continue
		}
		t.Run(c.name, func(t *testing.T) {
			_, cfgPath, _, _ := writeTwice(t, c)
			entries, err := os.ReadDir(filepath.Dir(cfgPath))
			if err != nil {
				t.Fatalf("read the config dir: %v", err)
			}
			seen := false
			for _, e := range entries {
				if e.Name() == filepath.Base(cfgPath) {
					seen = true
				}
				if strings.HasPrefix(e.Name(), ".atomic.") || strings.HasSuffix(e.Name(), ".tmp") {
					t.Errorf("left %s beside %s", e.Name(), filepath.Base(cfgPath))
				}
			}
			if !seen {
				t.Errorf("no %s in %s: the scan above compared nothing", filepath.Base(cfgPath), filepath.Dir(cfgPath))
			}
		})
	}
}

// An exception is a reason, and a reason that stopped being true is a row
// that skips silently: with a binary, the adapter would be asked nothing.
func TestEveryConfigWriteExceptionIsNamedAndTheRestAreAsked(t *testing.T) {
	asked := 0
	for _, c := range cases() {
		if c.configNeedsBinary == "" {
			asked++
		}
	}
	if asked < 6 {
		t.Errorf("only %d adapters are asked the config-write contract; the table lost rows or excused them", asked)
	}
}
