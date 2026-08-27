package core_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// How every adapter puts its config on disk, asked of all of them at once.
//
// A core config is read by somebody else — the core itself, on start and on
// reload — while the agent is writing it. `os.WriteFile` truncates the
// destination and then writes into it, so for the length of that write the file
// on disk is a prefix of the new config: empty, or half a JSON document. A core
// that reloads in that window reads a broken file, and a write that fails
// partway (or a machine that loses power) leaves that prefix behind FOREVER,
// under the final name, with the previous working config already gone. The
// agent's own error return says the write failed; the file says it succeeded.
//
// `internal/atomicfile` exists for exactly this: write a temp file beside the
// destination, fsync it, rename it over. Seven adapters used it. The eighth —
// sing-box, i.e. TUIC, AnyTLS, ShadowTLS and every engine=singbox inbound —
// wrote its config with `os.WriteFile`, which is the thing the package's own
// doc comment opens by naming as unsafe.
//
// The observable difference is the inode. Truncating in place keeps it; a
// rename replaces it. That is not a proxy for atomicity, it IS the property:
// the same inode means a reader holding the file sees it change underneath, a
// new one means every reader has either the whole old config or the whole new
// one. It also needs no fault injection and no root, so it can be asked of all
// eight in one loop.
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

func TestRewritingAConfigReplacesTheFileInsteadOfTruncatingIt(t *testing.T) {
	for _, c := range cases() {
		// hysteria is the one adapter that does not render on Start; its
		// config is written by ApplyInbound and covered in its own package.
		if !c.rendersOnStart {
			continue
		}
		t.Run(c.name, func(t *testing.T) {
			a, cfgPath := c.build(t, true)
			ctx := context.Background()
			if err := a.Start(ctx); err != nil {
				t.Fatalf("Start: %v", err)
			}
			t.Cleanup(func() { _ = a.Stop(context.Background()) })
			first := inodeOf(t, cfgPath)

			// A second render of the same config. Every adapter rewrites on
			// Start; the "unchanged, skipping" guards they have live in
			// ApplyInbound, not here.
			if err := a.Start(ctx); err != nil {
				t.Fatalf("second Start: %v", err)
			}
			second := inodeOf(t, cfgPath)

			if first == second {
				t.Errorf("the config was rewritten in place (inode %d both times): a core reloading "+
					"during that write reads a truncated file, and a write that dies partway leaves "+
					"one under the final name. Write through internal/atomicfile like the others.", first)
			}
		})
	}
}

// The other half: a rename-based write leaves a temp file beside the
// destination if it fails, and atomicfile removes it on every error path. A
// directory that accumulates `.atomic.*.tmp` is a config directory an operator
// cannot read, and it is also how a half-written config survives a reboot under
// a name nothing cleans up.
func TestAConfigWriteLeavesNothingBesideTheConfig(t *testing.T) {
	for _, c := range cases() {
		if !c.rendersOnStart {
			continue
		}
		t.Run(c.name, func(t *testing.T) {
			a, cfgPath := c.build(t, true)
			if err := a.Start(context.Background()); err != nil {
				t.Fatalf("Start: %v", err)
			}
			t.Cleanup(func() { _ = a.Stop(context.Background()) })

			entries, err := os.ReadDir(filepath.Dir(cfgPath))
			if err != nil {
				t.Fatalf("read the config dir: %v", err)
			}
			for _, e := range entries {
				if strings.HasPrefix(e.Name(), ".atomic.") || strings.HasSuffix(e.Name(), ".tmp") {
					t.Errorf("left %s beside %s", e.Name(), filepath.Base(cfgPath))
				}
			}
		})
	}
}
