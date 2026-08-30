package singbox

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"testing"
)

// The verbatim answer of the artefact the panel pins and ships: SagerNet
// sing-box v1.13.19, linux/amd64. `with_v2ray_api` is NOT in it, which is the
// whole reason statsListenForConfig exists.
const pinnedReleaseVersionOutput = `sing-box version 1.13.19

Environment: go1.25.12 linux/amd64
Tags: with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_acme,with_clash_api,with_tailscale,with_ccm,with_ocm,with_naive_outbound,badlinkname,tfogo_checklinkname0,with_musl
Revision: b5ebaa1fc0f2b94256180b95468e73ef53caa27d
CGO: enabled
`

func TestHasV2RayAPITag(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want bool
	}{
		{"pinned upstream release does not carry it", pinnedReleaseVersionOutput, false},
		{
			"a build made with the tag carries it",
			"sing-box version 1.13.19\n\nTags: with_quic,with_v2ray_api,with_utls\n",
			true,
		},
		{"first tag in the list", "Tags: with_v2ray_api,with_quic\n", true},
		{"last tag in the list", "Tags: with_quic,with_v2ray_api\n", true},
		{"sole tag", "Tags: with_v2ray_api\n", true},
		// A prefix match would say yes to both of these, and rendering the
		// block on a yes is what stops the core from starting.
		{"a longer tag that merely starts the same", "Tags: with_v2ray_api_v2\n", false},
		{"the tag named in prose, not in the tag list", "rebuild with -tags with_v2ray_api\n", false},
		{"no tags line at all", "sing-box version 1.13.19\n", false},
		{"empty output", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := hasV2RayAPITag(tc.out); got != tc.want {
				t.Fatalf("hasV2RayAPITag() = %v, want %v", got, tc.want)
			}
		})
	}
}

// newProbeAdapter builds a tuic adapter whose `sing-box` is a fake RunCmd
// answering `version` with the given output, and counts how often it is asked.
func newProbeAdapter(t *testing.T, versionOutput string, calls *atomic.Int32) *Adapter {
	t.Helper()
	dir := t.TempDir()
	return New(Config{
		Protocol:     "tuic",
		BinaryPath:   "/fake/sing-box",
		ConfigPath:   filepath.Join(dir, "config.json"),
		CertPath:     filepath.Join(dir, "cert.pem"),
		KeyPath:      filepath.Join(dir, "key.pem"),
		StatsListen:  "127.0.0.1:8082",
		XrayStatsBin: "/fake/xray",
		RunCmd: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) == 1 && args[0] == "version" {
				calls.Add(1)
				return []byte(versionOutput), nil
			}
			return nil, fmt.Errorf("unexpected command %v", args)
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

// renderedConfig applies an inbound in config-only-ish mode (the fake binary is
// never spawned because ApplyInbound's subprocess start fails) and returns the
// config the adapter wrote.
func renderedConfig(t *testing.T, a *Adapter) map[string]any {
	t.Helper()
	// The subprocess spawn of a non-existent binary fails; the config is
	// written before that, which is what we are here to read.
	_ = a.ApplyInbound(443, json.RawMessage(`{"serverName":"www.bing.com"}`))
	raw, err := os.ReadFile(a.cfg.ConfigPath)
	if err != nil {
		t.Fatalf("read rendered config: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("rendered config is not JSON: %v", err)
	}
	return doc
}

// The measurement this guards: with experimental.v2ray_api in the config, the
// pinned sing-box exits 1 ("v2ray api is not included in this build") before it
// opens a port, so the block must not be rendered for a binary that lacks it.
func TestStatsBlockOmittedWhenBinaryLacksTheTag(t *testing.T) {
	var calls atomic.Int32
	a := newProbeAdapter(t, pinnedReleaseVersionOutput, &calls)

	doc := renderedConfig(t, a)
	if _, ok := doc["experimental"]; ok {
		t.Fatalf("rendered experimental block for a sing-box built without %s; "+
			"that config makes the core exit before it opens a port:\n%v", v2rayAPITag, doc["experimental"])
	}
}

// The other direction, without which "omitted" is indistinguishable from
// "never rendered": a build that DOES carry the tag still gets its stats.
func TestStatsBlockRenderedWhenBinaryCarriesTheTag(t *testing.T) {
	var calls atomic.Int32
	a := newProbeAdapter(t,
		"sing-box version 1.13.19\n\nTags: with_quic,with_v2ray_api,with_utls\n", &calls)

	doc := renderedConfig(t, a)
	exp, ok := doc["experimental"].(map[string]any)
	if !ok {
		t.Fatalf("no experimental block for a sing-box built WITH %s: %v", v2rayAPITag, doc)
	}
	api, ok := exp["v2ray_api"].(map[string]any)
	if !ok {
		t.Fatalf("experimental block carries no v2ray_api: %v", exp)
	}
	if api["listen"] != "127.0.0.1:8082" {
		t.Fatalf("v2ray_api listen = %v, want the configured StatsListen", api["listen"])
	}
}

// A binary that cannot be asked is treated as lacking the tag: rendering the
// block on a guess is exactly what takes the core down.
func TestStatsBlockOmittedWhenTheProbeFails(t *testing.T) {
	dir := t.TempDir()
	a := New(Config{
		Protocol:    "tuic",
		BinaryPath:  "/fake/sing-box",
		ConfigPath:  filepath.Join(dir, "config.json"),
		CertPath:    filepath.Join(dir, "cert.pem"),
		KeyPath:     filepath.Join(dir, "key.pem"),
		StatsListen: "127.0.0.1:8082",
		RunCmd: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			return nil, fmt.Errorf("exec: no such file")
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	doc := renderedConfig(t, a)
	if _, ok := doc["experimental"]; ok {
		t.Fatalf("rendered experimental block though the build-tag probe failed: %v", doc["experimental"])
	}
}

// The probe forks a process; it must happen once, not once per config
// regeneration (a user add/remove re-renders).
func TestBuildTagProbeIsAskedOnce(t *testing.T) {
	var calls atomic.Int32
	a := newProbeAdapter(t, pinnedReleaseVersionOutput, &calls)

	_ = a.ApplyInbound(443, json.RawMessage(`{"serverName":"www.bing.com"}`))
	_ = a.AddUser(core.User{UserID: "u1", TuicUUID: "uuid1", TuicPassword: "pw1"})
	_ = a.AddUser(core.User{UserID: "u2", TuicUUID: "uuid2", TuicPassword: "pw2"})
	_, _ = a.GetStats()
	_, _ = a.GetStats()

	if got := calls.Load(); got != 1 {
		t.Fatalf("`sing-box version` asked %d times, want exactly 1", got)
	}
}

// Without a binary there is nothing to ask and nothing to run: config-only mode
// keeps rendering the full picture of what would be applied.
func TestConfigOnlyModeKeepsTheStatsBlock(t *testing.T) {
	dir := t.TempDir()
	a := New(Config{
		Protocol:    "tuic",
		ConfigPath:  filepath.Join(dir, "config.json"),
		StatsListen: "127.0.0.1:8082",
		RunCmd: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			return nil, fmt.Errorf("should not be asked without a binary")
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	doc := renderedConfig(t, a)
	if _, ok := doc["experimental"]; !ok {
		t.Fatalf("config-only mode dropped the stats block: %v", doc)
	}
}

// GetStats must not dial a port the config never asked sing-box to open: that
// is six adapters warning twice a minute forever, burying the one line that
// says why.
func TestGetStatsSkipsTheQueryWhenTheBinaryLacksTheTag(t *testing.T) {
	dir := t.TempDir()
	var statsQueries atomic.Int32
	a := New(Config{
		Protocol:     "tuic",
		BinaryPath:   "/fake/sing-box",
		ConfigPath:   filepath.Join(dir, "config.json"),
		StatsListen:  "127.0.0.1:8082",
		XrayStatsBin: "/fake/xray",
		RunCmd: func(_ context.Context, name string, args ...string) ([]byte, error) {
			if len(args) == 1 && args[0] == "version" {
				return []byte(pinnedReleaseVersionOutput), nil
			}
			if strings.Contains(strings.Join(args, " "), "statsquery") {
				statsQueries.Add(1)
				return nil, fmt.Errorf("failed to dial 127.0.0.1:8082")
			}
			return nil, fmt.Errorf("unexpected %s %v", name, args)
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	_ = a.AddUser(core.User{UserID: "u1", TuicUUID: "uuid1", TuicPassword: "pw1"})
	stats, err := a.GetStats()
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	if got := statsQueries.Load(); got != 0 {
		t.Fatalf("ran statsquery %d times against a build with no v2ray_api, want 0", got)
	}
	if len(stats.Users) != 1 || stats.Users[0].BytesIn != 0 {
		t.Fatalf("expected zeroed counters for the one user, got %+v", stats.Users)
	}
}
