import { adapterSlot, MULTI_INBOUND_ADAPTERS } from '@iceslab/shared';

/**
 * Where a squad's limit on a user does not hold on the node (A-204). A
 * property of the cores, not a fault the panel can fix, so the screen says it.
 *
 * The agent puts a user on the inbounds the squad names only through an
 * adapter that implements `core.ScopedUserAdder` (`AddUserOn`); any other
 * adapter gets the user on all of its inbounds (`apps/node/internal/server/
 * server.go`, the `core.ScopedUserAdder` switch in the user push, A-022).
 * Those adapters are the engines below; the test reads the agent's sources and
 * fails when an adapter gains or loses `AddUserOn`, so the list cannot drift.
 */
export const SCOPED_USER_ENGINES: readonly string[] = ['amneziawg', 'singbox', 'xray'];

/**
 *   shared-secret  mtproto: mtg serves one secret for every user
 *                  (`apps/node/internal/core/mtproto/adapter.go`, «single-secret
 *                  upstream»; AddUser and RemoveUser only count for stats), so
 *                  a secret from any subscription lets anyone in, a disabled
 *                  or expired user included;
 *   shared-users   an adapter that holds several inbounds on one node
 *                  (MULTI_INBOUND_ADAPTERS, shared) without AddUserOn: one user
 *                  list per process (mieru: `renderMulti`, `Users: jsonUsers`),
 *                  so a user the squad lets onto one of them gets through any
 *                  of them on that node.
 */
export type UserScopeGap = 'shared-secret' | 'shared-users';

export function userScopeGap(profile: {
  protocol: string;
  effectiveEngine: string;
  awgProtocol?: number | null;
}): UserScopeGap | null {
  if (profile.protocol === 'mtproto') return 'shared-secret';
  const slot = adapterSlot({ protocol: profile.protocol, engine: profile.effectiveEngine, awgProtocol: profile.awgProtocol });
  if (MULTI_INBOUND_ADAPTERS.includes(slot) && !SCOPED_USER_ENGINES.includes(profile.effectiveEngine)) return 'shared-users';
  return null;
}
