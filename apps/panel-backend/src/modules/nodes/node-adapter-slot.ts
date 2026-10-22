import { prisma } from '../../prisma.js';
import { effectiveEngineOf } from './node-engines.js';
import { profileAwgProtocol } from './node-core-gate.js';

/**
 * A-055: one inbound per adapter on a node, where the agent holds one.
 *
 * The agent hands an inbound to an adapter by the pair (protocol, engine),
 * and for AmneziaWG by (protocol, generation) (server.go:1113-1127, adapterFor).
 * Every adapter but native xray keeps ONE inbound: a second one pushed to it
 * silently replaces the first, so the operator sees two hosts and the node
 * serves one. List from the agent window, read in code 22.10:
 *   - single: hysteria, naive, shadowsocks, mtproto, mieru (native);
 *   - AmneziaWG: one per generation, 1.x and 3.1 apart;
 *   - sing-box: one per protocol (tuic, anytls, the xray family, hysteria,
 *     shadowsocks, shadowtls);
 *   - many: xray on xray only.
 *
 * Refused here, by name, until the agent ships multi-inbound for a pair; then
 * that pair joins MULTI and the refusal lifts for it alone.
 */
const MULTI = new Set(['xray|xray']);

export function adapterSlot(profile: { protocol: string; engine: string | null; awgProtocol?: number | null }): string {
  const gen = profileAwgProtocol(profile);
  if (gen !== null) return `amneziawg|${gen}`;
  return `${profile.protocol}|${effectiveEngineOf(profile)}`;
}

export class AdapterSlotTakenError extends Error {
  readonly code = 'ADAPTER_SLOT_TAKEN';
  constructor(
    public nodeName: string,
    public protocol: string,
    public engine: string,
    public heldBy: string,
  ) {
    super(
      `node "${nodeName}" already has an inbound ${protocol} on the ${engine} engine: "${heldBy}". ` +
        `The node holds one such inbound today; a second one would silently replace the first.`,
    );
    this.name = 'AdapterSlotTakenError';
  }
}

/** Refuses a new binding of `profile` on the node when its adapter already
 *  serves another binding there. The binding's own row is not counted. */
export async function assertAdapterSlotFree(
  node: { id: string; name: string },
  profile: { id: string; protocol: string; engine: string | null; awgProtocol?: number | null },
): Promise<void> {
  const slot = adapterSlot(profile);
  if (MULTI.has(slot)) return;
  const others = await prisma.profileNodeBinding.findMany({
    where: { nodeId: node.id, profileId: { not: profile.id } },
    select: {
      profile: { select: { name: true, protocol: true, engine: true, awgProtocol: true } },
      hosts: { select: { remark: true }, orderBy: { priority: 'asc' }, take: 1 },
    },
  });
  const held = others.find((b) => adapterSlot(b.profile) === slot);
  if (!held) return;
  const [protocol, engine] = slot.split('|') as [string, string];
  throw new AdapterSlotTakenError(
    node.name,
    protocol,
    protocol === 'amneziawg' ? `AmneziaWG ${engine === '3' ? '3.1' : '1.x'}` : engine,
    held.hosts[0]?.remark ?? held.profile.name,
  );
}
