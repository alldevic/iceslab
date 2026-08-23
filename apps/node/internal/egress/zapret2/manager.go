// Package zapret2 manages the node's optional zapret2 egress-desync service
// (B2a). ss-zapret2 runs as a SOCKS/SS proxy whose OWN egress is DPI-desynced
// by zapret2 (nfqws/nftables inside the proxy's network namespace), validated
// on a real node 2026-06-24: it desyncs the PROXIED egress, not the host's. So
// on a node inside a censored network, blocked traffic is routed INTO that
// SOCKS frontend by the node's egress policy (a socks outbound to
// 127.0.0.1:<socksPort>, compiled panel-side) and comes out desynced.
//
// This Manager owns only the zapret2 STRATEGY config and lifecycle: the panel
// renders a `config` body from a vendored preset and pushes it via
// /applyEgress, and the Manager writes the file and (re)starts the service.
//
// The Manager owns NO zapret2 logic itself, it just writes the config and runs
// an operator-configured up/down command (typically `docker compose ... up -d`
// for the ss-zapret2 image, or the zapret init script). That keeps the agent
// free of a Docker dependency: a node where zapret2 is not provisioned leaves
// the command unset and the Manager is a safe no-op.
package zapret2

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/atomicfile"
)

// RunCmdFunc executes an external command synchronously. Injectable for tests.
type RunCmdFunc func(ctx context.Context, name string, args ...string) ([]byte, error)

// applyTimeout caps a single up/down invocation (compose pull+restart can be slow).
const applyTimeout = 60 * time.Second

// Config configures the egress Manager.
type Config struct {
	// ConfigPath is where the resolved zapret2 `config` body is written
	// (e.g. /opt/ss-zapret2/config). When empty the Manager is fully inert:
	// Apply is a no-op. This is the default (no env set), the off-by-default
	// guarantee, so a node without egress provisioning behaves as pre-B2.
	ConfigPath string
	// UpCmd / DownCmd are the argv ([binary, args...]) that start / stop
	// zapret2. Empty UpCmd = "dormant": the Manager writes the config file but
	// skips the exec (config staged for a later provisioning, or used in tests).
	UpCmd   []string
	DownCmd []string
	// RunCmd runs UpCmd/DownCmd; defaults to exec.CommandContext. Injectable.
	RunCmd RunCmdFunc
}

// Manager applies egress policies idempotently. Safe for concurrent use.
type Manager struct {
	cfg    Config
	logger *slog.Logger

	mu          sync.Mutex
	applied     bool
	lastEnabled bool
	lastConfig  string
}

func New(cfg Config, logger *slog.Logger) *Manager {
	if cfg.RunCmd == nil {
		cfg.RunCmd = defaultRunCmd
	}
	return &Manager{cfg: cfg, logger: logger}
}

func defaultRunCmd(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// Apply (re)applies an egress policy and reports whether it actually changed
// anything. Idempotent: an unchanged (enabled, config) pair after a prior
// successful Apply is a no-op (returns false). With ConfigPath unset the
// Manager is inert (returns false). enabled=false tears the service down via
// DownCmd and leaves the config file untouched.
func (m *Manager) Apply(enabled bool, config string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.cfg.ConfigPath == "" {
		m.logger.Info("egress: no ConfigPath configured, ignoring applyEgress")
		return false, nil
	}
	if m.applied && enabled == m.lastEnabled && config == m.lastConfig {
		m.logger.Info("egress: policy unchanged, skipping", "enabled", enabled)
		return false, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), applyTimeout)
	defer cancel()

	if enabled {
		if err := writeConfig(m.cfg.ConfigPath, config); err != nil {
			return false, err
		}
		if err := m.run(ctx, true); err != nil {
			return false, err
		}
	} else if err := m.run(ctx, false); err != nil {
		return false, err
	}

	m.applied = true
	m.lastEnabled = enabled
	m.lastConfig = config
	return true, nil
}

// run execs the up/down argv. An empty argv (zapret2 not provisioned here) logs
// and returns nil: the config is staged on disk, nothing is started.
func (m *Manager) run(ctx context.Context, up bool) error {
	argv := m.cfg.DownCmd
	if up {
		argv = m.cfg.UpCmd
	}
	if len(argv) == 0 {
		m.logger.Info("egress: no command configured (zapret2 not provisioned), config persisted only",
			"action", actionName(up))
		return nil
	}
	out, err := m.cfg.RunCmd(ctx, argv[0], argv[1:]...)
	if err != nil {
		return fmt.Errorf("egress: %s failed: %w (%s)", actionName(up), err, string(out))
	}
	m.logger.Info("egress: zapret2 (re)applied", "action", actionName(up))
	return nil
}

func actionName(up bool) string {
	if up {
		return "up"
	}
	return "down"
}

// writeConfig replaces the zapret2 config through the shared atomicfile helper,
// which fsyncs the file AND its directory before returning. A plain
// write+rename is not crash-safe on Linux: after a power loss the rename can
// land while the data pages have not, leaving zapret2 to source a truncated
// config on the next boot and desync nothing. Mode 0644 because the zapret
// init scripts source it as a different user than the agent runs as.
func writeConfig(path, body string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("egress: mkdir %s: %w", dir, err)
	}
	if err := atomicfile.Write(path, []byte(body), 0o644); err != nil {
		return fmt.Errorf("egress: write config %q: %w", path, err)
	}
	return nil
}
