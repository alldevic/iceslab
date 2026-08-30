/**
 * Which core on a node serves a given profile, and how many inbounds that core
 * can hold at once.
 *
 * The node dispatches a pushed inbound on the PAIR (protocol, resolved engine),
 * not on the protocol alone - `core.MatchAdapter` in
 * `apps/node/internal/core/adapter.go` compares `Name()` and `Engine()`. This
 * file is the panel's half of that dispatch rule, so the panel can answer
 * "which core would this profile land on" before it pushes.
 *
 * Why the panel needs to know: every adapter but one holds exactly ONE inbound.
 * `ApplyInbound` overwrites a single `a.cfg.Inbound` / `a.inbound` field and
 * restarts the core, so a second inbound landing on the same adapter replaces
 * the first. Nothing fails on either side - the push reports `applied=2,
 * failed=0`, the node reports the core running, and the panel keeps handing out
 * links for the port that no longer has a listener. Measured 2026-08-30 on
 * n-lab-1 with two mtproto profiles (8443 + 9443): one mtg process on 9443, the
 * 8443 link still in the subscription, node `online`, core `running: true`,
 * `drift: false`, no log line above INFO.
 *
 * xray is the exception, and it is an exception on purpose: it keeps
 * `a.inbounds` keyed by the panel's binding id and implements
 * `core.InboundReconciler` (`RetainInbounds`) so deletions reach it too. That
 * interface is exactly the node's own statement of "this adapter holds several",
 * which is why the list below is derived from it rather than restated:
 * `node-adapter-keys.mirror.test.ts` reads the node's source and fails if an
 * adapter gains or loses `RetainInbounds` without this list moving with it.
 */

/**
 * The core that serves a protocol when the profile pins no engine. Mirrors
 * `dto.NativeEngine` in `apps/node/internal/dto/dto.go`; the mirror test
 * reads that function rather than trusting this comment.
 */
export function nativeEngineForProtocol(protocol: string): string {
  switch (protocol) {
    case 'shadowsocks':
      return 'xray';
    case 'tuic':
    case 'anytls':
    case 'shadowtls':
      return 'singbox';
    default:
      return protocol;
  }
}

/**
 * The node's adapter key for a profile: what `core.AdapterKey(protocol, engine)`
 * would produce for the inbound this profile pushes. Separator and argument
 * order match the node so the two strings are comparable by eye in a log.
 */
export function adapterKeyForProfile(
  protocol: string,
  engine: string | null | undefined,
): string {
  return `${protocol}|${engine || nativeEngineForProtocol(protocol)}`;
}

/**
 * Adapter keys whose core holds SEVERAL inbounds at once - the ones that
 * implement `core.InboundReconciler` on the node.
 *
 * Adding a key here is a claim about the node's code, not a policy knob: the
 * mirror test derives the same set from `func (a *Adapter) RetainInbounds` and
 * refuses a disagreement in either direction.
 */
export const MULTI_INBOUND_ADAPTER_KEYS: ReadonlySet<string> = new Set(['xray|xray']);

/** True when a node's core can serve more than one inbound of this kind. */
export function coreHoldsSeveralInbounds(
  protocol: string,
  engine: string | null | undefined,
): boolean {
  return MULTI_INBOUND_ADAPTER_KEYS.has(adapterKeyForProfile(protocol, engine));
}
