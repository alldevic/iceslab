import type { SubscriptionFormat } from './api';

/**
 * The formats a delivery rule may select, in the order the picker lists them.
 *
 * This is the SRR enum from `srr.schemas.ts`, not the wider set `/sub?format=`
 * accepts. `amneziavpn` is still absent and stays absent: it is a per-node
 * `vpn://` artefact, not a whole-subscription rendering, so no User-Agent
 * should resolve to it.
 *
 * `xrayjson-array` used to be missing too, and that gap had a cost — it is the
 * format built for Happ, and User-Agent matching is the only way a client
 * reaches a format, so Happ fell back to `plain` and got no routing section at
 * all. The rule schema now names it (see srr.schemas.ts), so the picker offers
 * it.
 */
export const SRR_FORMATS: SubscriptionFormat[] = [
  'plain',
  'xrayjson',
  'xrayjson-array',
  'singbox',
  'clash',
  'xkeen',
  'wgconf',
  'outline',
  'surge',
  'quantumultx',
  'loon',
  'json',
];

/**
 * Formats in which a balancer cascade survives. Both expand a cascade entry
 * into one server per exit (buildXrayJsonArray / expandEndpointUris); every
 * other format serves a single config, so the client has no exit to pick.
 */
export const CASCADE_AWARE_FORMATS: SubscriptionFormat[] = ['plain', 'xrayjson-array'];

/** Accent per format family, so a format reads the same in the table, the
 *  picker and the tester. */
export function formatTone(f: string): string {
  if (f === 'plain') return '#A7D8B9';
  if (f === 'xrayjson' || f === 'xrayjson-array' || f === 'xkeen') return '#7DD3FC';
  if (f === 'singbox') return '#A78BFA';
  if (f === 'clash') return '#67E8F9';
  if (f === 'wgconf') return '#F5B14C';
  return '#7A8BA3';
}
