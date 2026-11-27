import type { NodeCores } from '@iceslab/shared';

/**
 * Whether a tunnel profile's `subnet6` will take effect on a node (milestone
 * 18.9), from the facts the panel has: the three the server reads to decide
 * (awg-ipv6.ts). A node that fails one runs the profile without IPv6 in the
 * tunnel, and the screen says so where the profile is put on it.
 *
 * Not decided here: an AmneziaWG interface handed to a cascade chain also
 * stays IPv4 (until 18.12), which the server knows and the node list does not.
 *
 *   null      the profile has no subnet6, or the node will carry it;
 *   'off'     the node's IPv6 mode is off;
 *   'address' the host reported no global IPv6 address (or nothing yet);
 *   'agent'   the agent does not report IPv6 in the tunnel (awgIpv6), an
 *             agent older than milestone 18.10 among them.
 */
/**
 * Whether the node's agent serves a real prefix with no NAT66 (milestone 18.11,
 * the `awgNoNat6` fact). An agent of 18.10 does not: the panel keeps such a node
 * on the profiles' private subnets and NAT66, and the node screen says so.
 */
export function nodeServesRealPrefix(cores: NodeCores | null | undefined): boolean {
  return (cores?.cores ?? []).some(
    (c) => c.name === 'amneziawg' && (c.engine === undefined || c.engine === 'amneziawg') && c.awgNoNat6 === true,
  );
}

export type TunnelIpv6Gap = 'off' | 'address' | 'agent';

export function tunnelIpv6Gap(
  profile: { protocol: string; config?: unknown } | undefined,
  node: { ipv6Mode?: string; cores?: NodeCores | null },
): TunnelIpv6Gap | null {
  if (!profile || (profile.protocol !== 'amneziawg' && profile.protocol !== 'wireguard')) return null;
  const subnet6 = (profile.config as { subnet6?: unknown } | undefined)?.subnet6;
  if (typeof subnet6 !== 'string' || subnet6 === '') return null;
  if (node.ipv6Mode === 'off') return 'off';
  if (node.cores?.ipv6?.global !== true) return 'address';
  const row = node.cores.cores.find((c) => c.name === 'amneziawg' && (c.engine === undefined || c.engine === 'amneziawg'));
  return row?.awgIpv6 === true ? null : 'agent';
}
