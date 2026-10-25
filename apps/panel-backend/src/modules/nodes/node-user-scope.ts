import { adapterSlot, userScopeGap, type UserScopeGap } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { effectiveEngineOf } from './node-engines.js';

/**
 * A-204: the bindings on this node where a squad's limit on a user does not
 * hold, with why (userScopeGap, shared, the rule the squad screen reads too).
 *   - shared-secret (mtproto): always, one secret lets anyone in;
 *   - shared-users (mieru): only where the node carries TWO or more inbounds
 *     on that adapter. With one there is nothing to cross into: a user the
 *     squad does not grant it is not put on the adapter at all.
 * Disabled bindings are not pushed and are left out. Empty is none.
 */
export interface NodeUserScopeGap {
  bindingId: string;
  profileId: string;
  profileName: string;
  protocol: string;
  port: number;
  gap: UserScopeGap;
}

export async function nodeUserScopeGaps(nodeId: string): Promise<NodeUserScopeGap[]> {
  const bindings = await prisma.profileNodeBinding.findMany({
    where: { nodeId, enabled: true },
    select: {
      id: true,
      port: true,
      profile: { select: { id: true, name: true, protocol: true, engine: true, awgProtocol: true } },
    },
    orderBy: [{ port: 'asc' }, { id: 'asc' }],
  });
  const rows = bindings.map((b) => {
    const engine = effectiveEngineOf(b.profile);
    return {
      b,
      slot: adapterSlot({ protocol: b.profile.protocol, engine, awgProtocol: b.profile.awgProtocol }),
      gap: userScopeGap({ protocol: b.profile.protocol, effectiveEngine: engine, awgProtocol: b.profile.awgProtocol }),
    };
  });
  const perSlot = new Map<string, number>();
  for (const r of rows) perSlot.set(r.slot, (perSlot.get(r.slot) ?? 0) + 1);
  return rows
    .filter((r) => r.gap === 'shared-secret' || (r.gap === 'shared-users' && (perSlot.get(r.slot) ?? 0) >= 2))
    .map((r) => ({
      bindingId: r.b.id,
      profileId: r.b.profile.id,
      profileName: r.b.profile.name,
      protocol: r.b.profile.protocol,
      port: r.b.port,
      gap: r.gap!,
    }));
}
