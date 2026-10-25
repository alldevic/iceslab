import type { EngineName } from './transport.js';

/**
 * Which engine serves a protocol when nothing pins one.
 *
 * ⚠ Mirrors `dto.NativeEngine` in the agent (apps/node/internal/dto). The panel
 * server resolves through here (node-engines re-exports it), and so does the
 * screen: one table on this side of the wire, never a copy in the browser.
 */
export function nativeEngineFor(protocol: string): EngineName {
  switch (protocol) {
    case 'shadowsocks':
      return 'xray';
    case 'tuic':
    case 'anytls':
    case 'shadowtls':
      return 'singbox';
    default:
      // Every other protocol IS its own core: hysteria, amneziawg, naive,
      // mieru, mtproto (dto.NativeEngine returns EngineName(p) here).
      return protocol as EngineName;
  }
}

/**
 * The adapter a profile lands on in the agent: the pair adapterFor dispatches
 * on (apps/node server.go), (protocol, effective engine), and for AmneziaWG
 * (amneziawg, generation). A-055, moved here for A-175 so the server's gate
 * and the screen read one rule.
 */
export function adapterSlot(profile: {
  protocol: string;
  engine: string | null;
  awgProtocol?: number | null;
}): string {
  if (profile.protocol === 'amneziawg') return `amneziawg|${profile.awgProtocol === 3 ? 3 : 1}`;
  return `${profile.protocol}|${(profile.engine as EngineName | null) ?? nativeEngineFor(profile.protocol)}`;
}

/**
 * Adapters that hold SEVERAL inbounds on one node. Every other adapter holds
 * one, and a second binding onto it is refused (ADAPTER_SLOT_TAKEN), since the
 * agent would silently replace the first with it.
 *
 * Lifted per adapter as the agent ships multi-inbound for it: ONE line here,
 * read by the server's gate and by the screen.
 *   - xray|xray: native xray, always;
 *   - mieru|mieru: agent f8bac16 (22.10), one MTU per process (the server
 *     checks it, MIERU_MTU_MISMATCH);
 *   - the six protocols on sing-box: agent 22.10. A second inbound on a port
 *     already taken is refused by the port check, as on any node.
 * Not before v0.3.0 (owner, 22.10): native hysteria, AmneziaWG of one
 * generation. Still one each: native shadowsocks, naive, mtproto.
 */
export const MULTI_INBOUND_ADAPTERS: readonly string[] = [
  'xray|xray',
  'mieru|mieru',
  'xray|singbox',
  'tuic|singbox',
  'anytls|singbox',
  'hysteria|singbox',
  'shadowsocks|singbox',
  'shadowtls|singbox',
];

/**
 * A-204: where a squad's limit on a user does not hold on the node. A
 * property of the cores, not a fault the panel can fix, so it is said: on the
 * squad screen and in the node's sync status, by this one rule.
 *
 * The agent puts a user on the inbounds the squad names only through an
 * adapter that implements `core.ScopedUserAdder` (`AddUserOn`, A-022); any
 * other adapter gets the user on all of its inbounds. Those engines are listed
 * here, and a test reads the agent's sources so the list cannot drift.
 */
export const SCOPED_USER_ENGINES: readonly string[] = ['amneziawg', 'singbox', 'xray'];

/**
 *   shared-secret  mtproto: mtg serves one secret for every user (its
 *                  adapter: "single-secret upstream"; AddUser and RemoveUser
 *                  only count for stats), so a secret from any subscription
 *                  lets anyone in, a disabled or expired user included;
 *   shared-users   an adapter that holds several inbounds on one node
 *                  (MULTI_INBOUND_ADAPTERS) without AddUserOn: one user list
 *                  per process (mieru), so a user the squad lets onto one of
 *                  them gets through any of them on that node.
 */
export type UserScopeGap = 'shared-secret' | 'shared-users';

export function userScopeGap(profile: {
  protocol: string;
  /** The engine that serves it (the profile's, or the protocol's own). */
  effectiveEngine: string;
  awgProtocol?: number | null;
}): UserScopeGap | null {
  if (profile.protocol === 'mtproto') return 'shared-secret';
  const slot = adapterSlot({ protocol: profile.protocol, engine: profile.effectiveEngine, awgProtocol: profile.awgProtocol });
  if (MULTI_INBOUND_ADAPTERS.includes(slot) && !SCOPED_USER_ENGINES.includes(profile.effectiveEngine)) return 'shared-users';
  return null;
}

/** Steps of a cascade, entry to exit (A-175: was copied into the screen). */
export const MAX_CASCADE_HOPS = 5;
