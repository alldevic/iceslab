import type { RoutingPresetId } from '@iceslab/shared';
import { config } from '../../config.js';
import { splitGeoTags } from '../routing-presets/routing-presets.builtins.js';
import { formatIp, geoipEntries, geositeEntries } from './geo-dat.js';
import type { GeoSiteDomain } from './geo-formats.js';
import { parsedVersion } from './geo-push.js';
import { servedSet } from './geo-self-host.js';

/**
 * The matchers of a built-in split preset, written out (milestone 12.5), for
 * the xray-json documents of clients that trim their geo files to the tags of
 * their own routing profile (Happ and INCY on mobile): a category the document
 * names is then not there. Taken from the current verified versions of the
 * built-in geosite and geoip sets, in xray's own spelling.
 *
 * ru-split only: cn-split is not embedded (about 4 MB of list; customer
 * decision on 12.5) and is issued as the base writes it, with `geosite:`/`geoip:`.
 *
 * null (the document names the categories, as the base writes it) while
 * SUBSCRIPTION_XRAY_GEO_INLINE is off, for any preset but ru-split, and
 * whenever the answer would be partial: a set that is not served (no verified
 * version, or broken), a category the set does not have, or one that is empty.
 * A narrower split is worse than a document that names the categories.
 *
 * Domains only as xray reads the same category: plain -> `keyword:`, regex ->
 * `regexp:`, domain -> `domain:` (the name and its subdomains), full -> `full:`.
 * Networks IPv4 only: every path of the panel is IPv4 today, and an IPv6 network
 * would not match what an exit carries (TODO(m18.7): with IPv6 exits the region's
 * IP rule does not match IPv6 addresses until the lists carry them).
 */
export interface PresetGeoInline {
  /** Per geosite tag the preset names (lower case): matchers, de-duplicated, in file order. */
  domains: Record<string, string[]>;
  /** Per geoip tag the preset names (lower case): IPv4 networks as `a.b.c.d/n`, de-duplicated, in file order. */
  cidrs: Record<string, string[]>;
}

const XRAY_PREFIX: Record<GeoSiteDomain['type'], string> = { plain: 'keyword:', regex: 'regexp:', domain: 'domain:', full: 'full:' };

// By preset and the sha256 of both versions: a new current version is a new
// key, and the content under a sha never changes, so nothing goes stale.
const KEEP = 8;
const memo = new Map<string, PresetGeoInline | null>();

export async function presetGeoInline(preset: RoutingPresetId): Promise<PresetGeoInline | null> {
  if (!config.SUBSCRIPTION_XRAY_GEO_INLINE || preset !== 'ru-split') return null;
  const want = splitGeoTags(preset);
  if (want.geosite.length === 0 || want.geoip.length === 0) return null;
  const [site, ip] = await Promise.all([servedSet('geosite'), servedSet('geoip')]);
  if (!site || !ip) return null;
  if (!want.geosite.every((t) => site.tags.has(t)) || !want.geoip.every((t) => ip.tags.has(t))) return null;

  const key = `${preset}|${site.sha256}|${ip.sha256}`;
  if (memo.has(key)) return memo.get(key)!;
  const [s, i] = await Promise.all([parsedVersion(site.sha256, 'geosite'), parsedVersion(ip.sha256, 'geoip')]);
  const out: PresetGeoInline = { domains: {}, cidrs: {} };
  for (const t of want.geosite) {
    out.domains[t] = [...new Set(geositeEntries(s.buf, s.index, t).map((d) => XRAY_PREFIX[d.type] + d.value))];
  }
  for (const t of want.geoip) {
    out.cidrs[t] = [
      ...new Set(
        geoipEntries(i.buf, i.index, t)
          .filter((c) => c.ip.length === 4)
          .map((c) => `${formatIp(c.ip)}/${c.prefix}`),
      ),
    ];
  }
  const complete = [...Object.values(out.domains), ...Object.values(out.cidrs)].every((l) => l.length > 0);
  const result = complete ? out : null;
  if (memo.size >= KEEP) memo.delete(memo.keys().next().value!);
  memo.set(key, result);
  return result;
}

/** For tests. */
export function resetPresetGeoInlineMemo(): void {
  memo.clear();
}
