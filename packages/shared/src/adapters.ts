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
 *     checks it, MIERU_MTU_MISMATCH).
 * Not before v0.3.0 (owner, 22.10): hysteria, AmneziaWG of one generation.
 */
export const MULTI_INBOUND_ADAPTERS: readonly string[] = ['xray|xray', 'mieru|mieru'];

/** Steps of a cascade, entry to exit (A-175: was copied into the screen). */
export const MAX_CASCADE_HOPS = 5;
