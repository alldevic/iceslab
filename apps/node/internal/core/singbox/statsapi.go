package singbox

import (
	"context"
	"strings"
	"time"
)

// v2rayAPITag is the sing-box build tag that compiles in `experimental.v2ray_api`,
// the StatsService this adapter reads per-user byte counters from (see stats.go).
const v2rayAPITag = "with_v2ray_api"

// hasV2RayAPITag reports whether a `sing-box version` output lists the
// v2ray_api build tag.
//
// Read off the real binary rather than assumed, because the assumption was
// wrong: the pinned upstream release (SagerNet/sing-box v1.13.19, the artefact
// the panel carries and verifies by sha256) answers
//
//	Tags: with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_acme,
//	      with_clash_api,with_tailscale,with_ccm,with_ocm,with_naive_outbound,...
//
// and `with_v2ray_api` is not among them.
//
// Matched on the comma-separated list so `with_v2ray_api_something` cannot pass
// for it, and so the substring cannot be found in an unrelated line.
func hasV2RayAPITag(versionOutput string) bool {
	for _, line := range strings.Split(versionOutput, "\n") {
		rest, ok := strings.CutPrefix(strings.TrimSpace(line), "Tags:")
		if !ok {
			continue
		}
		for _, tag := range strings.Split(rest, ",") {
			if strings.TrimSpace(tag) == v2rayAPITag {
				return true
			}
		}
	}
	return false
}

// statsListenForConfig answers what to render into `experimental.v2ray_api`:
// the configured listen address, or "" when this node's sing-box cannot serve
// one.
//
// It exists because sing-box does not IGNORE an experimental block it was not
// built to honour — it refuses to start at all:
//
//	FATAL create service: create v2ray-server: v2ray api is not included in
//	this build, rebuild with -tags with_v2ray_api
//
// and exits 1 before opening a single port. Measured on a lab node 2026-08-30
// against the pinned v1.13.19 release: every sing-box config this adapter
// renders carries the block, so sing-box crash-looped to its restart budget and
// stayed down. That is six of the node's eight adapters — TUIC, AnyTLS,
// ShadowTLS and engine=singbox for xray, shadowsocks and hysteria — none of
// which could ever have served a byte on a node whose binary came from the
// panel. The panel showed the profile applied (`applied=1`) while the core was
// dead; it reported the node `degraded` and quoted the FATAL, which is the only
// reason this was visible at all.
//
// The trade is deliberate and one-directional: without the block sing-box runs
// and GetStats reports zeros (the panel meters no traffic for these users);
// with it, nothing runs. A protocol that carries traffic unmetered beats a
// protocol that carries nothing, and the probe asks the binary rather than
// hard-coding the answer, so a sing-box built with the tag turns accounting
// back on by itself.
//
// Cached: a binary that lacks the tag will not grow it, and re-forking a
// process on every config regeneration to find that out again is the cost this
// avoids (same contract as core.CachedVersion).
func (a *Adapter) statsListenForConfig(binPath, statsListen string) string {
	if statsListen == "" {
		return ""
	}
	// Config-only mode: no binary to ask, and nothing will run the config
	// either. Render what was configured, so the config-only output stays the
	// full picture of what this adapter would apply.
	if binPath == "" {
		return statsListen
	}

	supported := a.statsAPI.Get(func() string {
		a.mu.Lock()
		run := a.cfg.RunCmd
		a.mu.Unlock()
		if run == nil {
			return ""
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := run(ctx, binPath, "version")
		if err != nil {
			// Unknown, and treated as absent: rendering the block on a guess is
			// what takes the core down.
			a.logger.Warn("sing-box build-tag query failed; rendering without per-user stats",
				"err", err)
			return ""
		}
		if !hasV2RayAPITag(string(out)) {
			a.logger.Warn("sing-box was built without "+v2rayAPITag+
				": serving this protocol WITHOUT per-user traffic accounting, because a config carrying experimental.v2ray_api makes sing-box exit before it opens a port",
				"protocol", a.protocol, "binary", binPath)
			return ""
		}
		return "yes"
	})

	if supported == "" {
		return ""
	}
	return statsListen
}
