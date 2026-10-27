package hysteria

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/icecompany-tech/iceslab/apps/node/internal/atomicfile"
)

/*
A-265: the hysteria systemd runs logs at error too (LogLevelEnv says why).

The unit comes from the installer, and on nodes installed before A-265 it has
no HYSTERIA_LOG_LEVEL, so hysteria logs every client's IP and user id at info;
the installer of 26.10 wrote warn, which still names the client on every
connection that ends in an error. Either is overridden here.
The agent cannot fix the unit file: its own unit runs under ProtectSystem=strict
and /etc/systemd/system is not among its ReadWritePaths (install-iceslab-node.sh),
and reinstalling the agent to widen them wipes its mTLS keys. /run is writable,
and systemd reads drop-ins from /run/systemd/system as well (runtime units).

So on every start of the adapter: if the unit's environment already carries
the level (a new installer sets it in the unit, or the drop-in is still there),
nothing is done. The drop-in's Environment= comes after the unit's, and for
the same variable systemd keeps the later assignment (systemd.exec,
Environment=), which is also what `systemctl show -p Environment` answers
after the reload: one try-restart, then the check finds the level and stops. Otherwise the runtime drop-in is written, systemd reloaded and
the unit try-restarted, which restarts it only if it runs: a hysteria the agent
idled for want of an inbound stays down. /run is empty after a reboot, so a node
whose unit lacks the line restarts hysteria once after each boot.
*/

// RuntimeUnitDir is where systemd reads runtime unit drop-ins.
const RuntimeUnitDir = "/run/systemd/system"

const logDropInName = "iceslab-log.conf"

// CmdOutputFunc runs a command and answers its standard output.
type CmdOutputFunc func(ctx context.Context, name string, args ...string) ([]byte, error)

func defaultCmdOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

// unitName is the unit with its suffix: HYSTERIA_SERVICE_UNIT may say
// "hysteria" or "hysteria.service", the drop-in directory needs the latter.
func unitName(u string) string {
	if strings.Contains(u, ".") {
		return u
	}
	return u + ".service"
}

func logDropIn() []byte {
	return []byte("# Written by iceslab-node (A-265): below error hysteria logs the client's IP\n" +
		"# and user id (info: every connect; warn: every broken connection).\n" +
		"# Runtime: gone after a reboot, written again.\n" +
		"[Service]\nEnvironment=" + LogLevelEnv + "\n")
}

// ensureUnitLogLevel gives the systemd unit LogLevelEnv when its
// environment does not carry it. Best-effort: a node it fails on keeps
// serving, and says why in the agent's log.
func (a *Adapter) ensureUnitLogLevel(ctx context.Context) {
	unit := unitName(a.cfg.ServiceUnit)
	out, err := a.cfg.CmdOutput(ctx, "systemctl", "show", "-p", "Environment", "--value", unit)
	if err != nil {
		a.logger.Warn("hysteria: could not read the unit's environment, log level left as it is", "unit", unit, "err", err)
		return
	}
	for _, kv := range strings.Fields(string(out)) {
		if kv == LogLevelEnv {
			return
		}
	}
	dir := filepath.Join(a.cfg.RuntimeUnitDir, unit+".d")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.logger.Warn("hysteria: could not create the runtime drop-in directory", "dir", dir, "err", err)
		return
	}
	path := filepath.Join(dir, logDropInName)
	if err := atomicfile.Write(path, logDropIn(), 0o644); err != nil {
		a.logger.Warn("hysteria: could not write the log level drop-in", "path", path, "err", err)
		return
	}
	for _, args := range [][]string{{"daemon-reload"}, {"try-restart", unit}} {
		if err := a.cfg.RunCmd(ctx, "systemctl", args...); err != nil {
			a.logger.Warn("hysteria: systemctl "+strings.Join(args, " ")+" after the log level drop-in failed", "err", err)
			return
		}
	}
	a.logger.Info(fmt.Sprintf("hysteria: %s now runs with %s (runtime drop-in %s)", unit, LogLevelEnv, path))
}
