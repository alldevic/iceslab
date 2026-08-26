import { z } from 'zod';

/**
 * Every value `/sub/<token>?format=` serves, in one place.
 *
 * It used to be two places. `subscription.routes.ts` had the union the route
 * accepts, `hosts.schemas.ts` had the one `disableForFormats[]` accepts, and a
 * comment on the second said "Mirrors the union in subscription.routes.ts.
 * Keep in sync." They had drifted in both directions by the time anyone
 * looked, and both directions are quiet:
 *
 *   - `mieru-json` was in the host list and has never been a format. The
 *     route rejects it, so an operator could set it, be told the host was
 *     saved, and have hidden the host from nothing. (It was planned: the
 *     comment on `buildMieruProfileJson` still claimed the route returned it,
 *     and nothing ever called that builder.)
 *   - `json`, `amneziavpn` and `xrayjson-array` are formats the route renders
 *     separately, and no host could be hidden from any of them: the field
 *     refused the name with a 400.
 *
 * The gate compares this string to the one in the query
 * (`subscription.routes.ts`), so the two lists being one list is what makes
 * the feature work at all.
 */
export const SUBSCRIPTION_FORMATS = [
  'plain',
  'json',
  'clash',
  'singbox',
  'wgconf',
  'amneziavpn',
  'xrayjson',
  'xrayjson-array',
  'xkeen',
  'outline',
  'surge',
  'quantumultx',
  'loon',
] as const;

export const FormatEnum = z.enum(SUBSCRIPTION_FORMATS);
export type Format = z.infer<typeof FormatEnum>;
