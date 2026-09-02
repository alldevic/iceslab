package core

import (
	"context"
	"encoding/json"
	"time"
)

// CoreAdapter is the central abstraction of Iceslab: every proxy core wraps
// behind this interface, which lets the dispatcher treat them uniformly.
//
// Implementations live in `internal/core/<protocol>/` and are registered
// from main at startup based on which protocols the node is configured for.
//
// Contract notes:
//   - All methods are expected to be goroutine-safe.
//   - `AddUser` and `RemoveUser` MUST be idempotent, the panel may retry
//     a job after a partial failure, so re-applying the same operation is
//     a no-op.
//   - `Start` blocks only long enough to launch the underlying binary; it
//     does NOT wait for the binary to be ready to accept traffic. Use
//     `GetStats` polling or a healthcheck for readiness.
type CoreAdapter interface {
	// Name returns the protocol identifier (matches dto.ProtocolName).
	Name() string

	// Engine returns the proxy-core identifier this adapter renders with
	// ("xray", "hysteria", "singbox", ...). The dispatcher matches an inbound
	// to an adapter by BOTH Name()==protocol AND Engine()==resolved-engine, so
	// one protocol can be served by different cores (engine-choice). Native
	// adapters return their single core; the sing-box adapter returns "singbox".
	Engine() string

	// Start launches the underlying core (subprocess, in-process server, ...).
	// Returning nil means the launch was initiated; readiness is asynchronous.
	Start(ctx context.Context) error

	// Stop gracefully terminates the core. Implementations should respect a
	// shutdown deadline (~5s) and force-kill on timeout.
	Stop(ctx context.Context) error

	// AddUser registers a user with the core. Idempotent.
	AddUser(user User) error

	// RemoveUser unregisters a user by id. Idempotent.
	RemoveUser(userID string) error

	// GetStats returns the latest traffic counters known to the core.
	GetStats() (*Stats, error)

	// Healthy reports whether the adapter is in a state where it can serve
	// traffic. Implementations should return true after Start() has fully
	// initialised local resources (callback servers, subprocesses, etc) and
	// false before Start() / after Stop() / when a subprocess has crashed.
	//
	// Used by the panel's healthcheck fan-out and the node-agent /healthz
	// endpoint to derive overall node status.
	Healthy() bool

	// ApplyInbound takes the inbound port plus the protocol-specific config as
	// raw JSON (the latter is the same shape the panel pushes via
	// /applyInbounds, see dto.InboundDto.Config). Implementations parse what
	// they need, regenerate their config file, and reload/restart the
	// underlying server.
	//
	// Port was added (slice 50, 2026-05-20) because adapters used to read the
	// listen port from install-time config only. Admin couldn't change a
	// protocol's port through the panel UI: a port change in the binding
	// landed in the outer InboundDto.Port but the adapter never saw it, so
	// the rendered config (e.g. /etc/hysteria/config.yaml) kept the install-
	// time port forever. Now port is first-class on every applyInbound call.
	//
	// Contract:
	//   - Idempotent: re-applying the same (port, config) is a no-op (no restart).
	//   - Non-blocking on success: launches reload/restart asynchronously,
	//     returns once the new config is on disk.
	//   - Returns an error if the config JSON is malformed for this protocol
	//     or the regenerate/reload step fails.
	//   - When called with a config that doesn't match the adapter's protocol
	//     (e.g. xray cfg pushed to hysteria adapter), implementations should
	//     return nil, the dispatcher routes by protocol name, but defensive
	//     no-op is the safer contract.
	//
	// Slice 24b: replaces the env-var-only inbound config workflow that
	// admins had to hand-edit on every change. Panel auto-pushes via
	// /applyInbounds, dispatcher fans out to the matching adapter.
	ApplyInbound(port int, cfg json.RawMessage) error
}

// RestartStats is an adapter's running tally of core restarts, surfaced on
// /healthz and stored per node by the panel.
//
// Why this is reported at all (2026-08-04): the memory watchdog restarts a core
// before it eats the box, and a restart drops live connections. Without a
// visible counter that trade is invisible - the core quietly bounces, users
// complain about drops, and the panel shows a green node. The number is the
// feature as much as the restart is.
//
// Counters are cumulative since the ADAPTER started, not since the process
// started: a config push replaces the underlying process, and resetting the
// tally exactly when an operator is investigating would defeat the point. They
// do reset when the agent restarts; the panel tolerates a counter going
// backwards (it means "agent restarted", not "restarts un-happened").
type RestartStats struct {
	// Crash / Memory: restarts by cause. Memory means the watchdog acted
	// before an OOM; Crash means the process died on its own.
	Crash  int
	Memory int
	// LastAt is zero when nothing has restarted yet.
	LastAt     time.Time
	LastReason string
	// SinceAt is when this adapter started counting, i.e. when the agent came
	// up. Without it "3 restarts" is unreadable: it could mean this morning or
	// six months ago. Reported so the panel can say "3 since <date>".
	SinceAt time.Time
	// MemoryLimitBytes is the armed ceiling (0 = watchdog off), RSSBytes the
	// latest sample. Together they let the panel show how close a core runs
	// to the line instead of only counting the times it crossed it.
	MemoryLimitBytes uint64
	RSSBytes         uint64
}

// InboundReconciler is an OPTIONAL interface for adapters that hold SEVERAL
// inbounds at once. `applyInbounds` carries the panel's full set for this node,
// but it is dispatched to adapters one inbound at a time, so an adapter that
// accumulates them never learns that one was deleted.
//
// Without this, removing an inbound in the panel leaves it serving on the node
// forever: still listening, still accepting the users it knew about. Found in
// the field 2026-08-08, right after multi-inbound landed.
type InboundReconciler interface {
	// RetainInbounds drops every inbound whose id is not in `keep`, and
	// restarts the core if anything went away. `keep` is the complete set for
	// this adapter in the push that just landed. An EMPTY set means the node
	// has no inbounds of this kind any more, which is a legitimate state.
	RetainInbounds(keep []string) error
}

// MultiInbound is an OPTIONAL interface an adapter implements to state that its
// core can serve MORE THAN ONE inbound of its (protocol, engine) pair at once.
//
// Split from InboundReconciler because the two answer different questions, and
// conflating them cost the wg adapters their reconciliation. "Can this adapter
// be told what the panel no longer sends" is one question; "may two profiles be
// deployed onto this core" is another. xray answers yes to both. An adapter that
// holds ONE inbound still needs the first — the way to remove its inbound is to
// be told the set no longer contains it — while the panel must keep refusing a
// second profile on it.
//
// The panel mirrors this set (MULTI_INBOUND_ADAPTER_KEYS) and a mirror test
// reads these implementations, so declaring it here is a statement about how the
// adapter STORES inbounds, not a preference.
type MultiInbound interface {
	// HoldsSeveralInbounds is true for an adapter keeping its inbounds keyed by
	// the panel's id, false-by-absence for one whose ApplyInbound overwrites a
	// single field.
	HoldsSeveralInbounds() bool
}

// UserReconciler is an OPTIONAL interface for adapters that must be able to
// notice a user (or a device) the panel no longer sends.
//
// Same shape and the same reason as InboundReconciler: `addUser` is dispatched
// one record at a time, so an adapter that only ever adds keeps serving whoever
// it was told about once. RemoveUser closes the gap only for a removal the panel
// KNOWS to address — it drops one id and returns nil on an id it does not hold,
// having reported ok — so anything the panel forgot to name, or named while the
// node was unreachable, lives forever.
//
// For the wg family this is not bookkeeping: a peer is the access. A device
// deleted while its node was down keeps a working tunnel until someone runs
// `awg-quick down` by hand.
type UserReconciler interface {
	// RetainUsers drops every user whose id is not in `keep` and reloads if
	// anything went away. `keep` is the panel's COMPLETE set for this node —
	// user ids and, for adapters keyed per device, device ids. An EMPTY set is
	// legitimate (a node with nobody on it) and must be honoured, not ignored.
	RetainUsers(keep []string) error
}

// Provisionable is an OPTIONAL interface for adapters that can be REGISTERED
// without being CONFIGURED. The installer registers an adapter for every
// protocol the operator might switch on later, and such an adapter sits idle
// until the panel pushes it an inbound ("waiting for ApplyInbound from panel").
//
// Without this distinction /healthz reports one thing for two different states:
// a core that is configured and has died (a fault worth waking someone for) and
// a core nobody has configured yet (the normal state of a fresh node). Every
// node of the field fleet therefore reported `degraded` permanently, so when a
// core actually crashes the status does not change. A signal that is always on
// carries nothing.
//
// Adapters that don't implement this are treated as configured, which is the
// behaviour that predates the interface.
type Provisionable interface {
	// Provisioned reports whether this core has the configuration it needs to
	// run. It must be the SAME condition Start uses to decide whether to defer,
	// otherwise the two disagree and the status is a guess.
	Provisioned() bool
}

// RestartReporter is an OPTIONAL interface an adapter may implement to report
// the above. /healthz type-asserts each adapter against it, exactly like
// Versioner below; adapters that don't implement it simply report nothing.
type RestartReporter interface {
	// RestartStats must be goroutine-safe and cheap: it is called on every
	// healthcheck poll (every 30s per node).
	RestartStats() RestartStats
}

// KeyGenerator is an OPTIONAL interface an adapter may implement when its core
// binary can mint key material that would otherwise have to be generated by
// hand on some machine and pasted into the panel. The /generateKeys handler
// type-asserts each adapter against it, exactly like Versioner below.
//
// `kind` is the core's own subcommand name rather than a name of ours, and the
// adapter returns that command's output VERBATIM. What the panel wants out of
// it (a seed, a decryption string) moves with the core version, and a parser on
// this side would have to be shipped to every node to keep up; the panel parses
// instead, and shows the raw output when it cannot.
type KeyGenerator interface {
	// GenerateKeys runs the core's keygen subcommand and returns its stdout. It
	// must reject a kind it does not know rather than shelling out with it.
	GenerateKeys(kind string) (string, error)
}

// Versioner is an OPTIONAL interface an adapter may implement to report the
// version of its underlying core binary (e.g. the output of `xray version`).
// The /healthz handler type-asserts each adapter against it and, when present,
// includes the version in that core's CoreStatus. Adapters that don't implement
// it simply report an empty version. The panel persists this per node so it can
// gate features that need a minimum core version (e.g. cascade exit selection
// via vlessRoute needs xray >= 25.9.5).
// FailureReporter is implemented by adapters that can say WHY their core is
// down, not merely that it is.
//
// Before this the panel showed `degraded`, `not running: xray` and a crash
// counter - all true, none of them the reason. The reason was in the node's
// journal, on a machine the operator has to go find, and nothing connected the
// crash to the profile they had just saved. Watched live: a config with a
// listen port already taken produced sixteen crashes and a status message that
// named the core and stopped there.
//
// Only meaningful for a core the caller already knows is not running - a live
// core's last line is ordinary chatter.
type FailureReporter interface {
	// LastFailure returns the last thing the core printed, or "" when it
	// printed nothing (or the adapter supervises no process).
	LastFailure() string
}

type Versioner interface {
	// CoreVersion returns the core binary version string, or "" if unknown
	// (config-only mode, binary missing, or the version query failed). It must
	// be goroutine-safe and cheap to call repeatedly (implementations cache).
	CoreVersion() string
}

// AdapterKey is how a (protocol, engine) pair is written as one string. The
// dispatcher and the deletion reconciler both key on the pair, and they must
// key on it the same way or an adapter would be handed the keep-list of a
// different one.
func AdapterKey(protocol, engine string) string { return protocol + "|" + engine }

// MatchAdapter picks the adapter that serves a (protocol, engine) pair, or nil.
//
// This is THE dispatch rule for a pushed inbound, so it lives here rather than
// inline in the handler: an inbound whose pair no adapter claims is not an
// error anywhere, it is a warning line and a config that was persisted but
// never applied. The node looks healthy and serves nothing for that protocol,
// which is how amneziawg (cycle #6) and naive (cycle #8) each shipped an
// adapter nobody could reach.
func MatchAdapter(adapters []CoreAdapter, protocol, engine string) CoreAdapter {
	for _, a := range adapters {
		if a.Name() == protocol && a.Engine() == engine {
			return a
		}
	}
	return nil
}
