import { GEO_SITE_ARTIFACT, GEO_IP_ARTIFACT } from '../geo/geo.orchestrator.js';
import type { EgressPolicy } from './cascade.geo.js';

/**
 * Fail-closed authoring-time validation of the STANDARD geo categories a cascade
 * egress policy references.
 *
 * A bare `geosite:`/`geoip:` matcher resolves against the NODE's bundled
 * geosite.dat / geoip.dat (install-iceslab-node.sh seeds these from the pinned
 * xray release's /usr/local/share/xray/*.dat), NOT against the panel's source
 * mirror. A name absent from the node bundle makes xray fail config-load. The
 * node's `xray -test` preflight now refuses such a swap so there is no outage,
 * but the split would then silently not apply - so we also reject the two
 * high-signal authoring mistakes here, up front, with a clear message:
 *
 *  1. A CUSTOM category (defined from the operator's geo sources, e.g. a
 *     runetfreedom-only category) used as a bare `geosite:`/`geoip:`. It exists
 *     in the panel's sources but NOT in the node bundle; it must be referenced
 *     as a custom category, which the panel serves to the node as
 *     `ext:geo-custom.dat:<cat>` and validates against the actual build.
 *  2. A `geoip:` name that is not a country code / standard geoip category (a
 *     typo). geoip.dat has a small closed vocabulary, so this is safe to check
 *     exhaustively. The much larger geosite vocabulary is version-specific and
 *     impractical to mirror in the panel, so bare geosite: existence is left to
 *     the node's `xray -test` preflight (which is authoritative for this node's
 *     actual bundle); only the two mistakes above are rejected here.
 *
 * REGENERATE for your deployment if a node bundles a non-default geoip.dat: dump
 * the real category set on a node and reconcile GEOIP_CATEGORIES (see
 * docs/geo-svc-prod-checklist.md).
 */

// ISO-3166-1 alpha-2 country codes (the bulk of geoip.dat) plus the well-known
// v2fly/Loyalsoldier geoip specials. Generous on purpose: a name here that a
// given node bundle happens to lack still fails safe (the node's -test preflight
// rejects the swap and keeps the old config), whereas a missing valid code would
// wrongly block an operator. Lowercased; matchers are compared case-insensitively.
const GEOIP_CATEGORIES = new Set(
  (
    'ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz ' +
    'ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo ' +
    'fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je ' +
    'jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo ' +
    'mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw ' +
    'py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm ' +
    'tn to tr tt tv tw tz ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw ' +
    // Standard non-country geoip categories present in common geoip.dat builds.
    'private telegram cloudflare cloudfront google netflix facebook twitter fastly bing apple microsoft'
  ).split(/\s+/),
);

// A category token: an optional leading `!` (xray negation, e.g. `geoip:!cn` =
// "everything except CN" - a canonical split), then leading/trailing alnum with
// inner dot/underscore/dash/bang (`category-ads-all`, `private`, `geolocation-!cn`).
// Rejects whitespace, control chars, and other junk that would break config-load.
const CATEGORY_TOKEN = /^!?[A-Za-z0-9](?:[A-Za-z0-9._!-]*[A-Za-z0-9])?$/;

export interface EgressCategoryIssue {
  matcher: string;
  reason: string;
}

/**
 * Which policy is being judged, because one answer differs between them.
 *
 * A custom category is an authoring mistake in both scopes, but the WAY OUT is
 * not the same: a cascade member can reference it (the panel delivers the file
 * as a fragment), a node's own policy cannot reference it at all. Telling a node
 * operator to write `ext:` would send them to a form NodeEgressPolicySchema then
 * refuses.
 */
export type EgressScope = 'cascade' | 'node';

/** Extract the standard category name from a `geosite`/`geoip` array entry, or
 *  null when the entry is already qualified with some OTHER prefix (ext:,
 *  domain:, full:, regexp:, keyword:, an IPv6 literal) - those are validated
 *  elsewhere (reconcile for ext:, pass-through for the rest). */
function standardName(entry: string, kind: 'geosite' | 'geoip'): string | null {
  const prefix = `${kind}:`;
  if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  if (entry.includes(':')) return null; // ext:/domain:/regexp:/IPv6 -> not a bare standard category
  return entry;
}

/**
 * Return the authoring mistakes in a policy's standard category matchers (empty
 * = clean). Pure: `customCategoryNames` is the set of the operator's defined
 * custom-category names, so this is testable without the DB.
 */
export function validateEgressCategories(
  policy: EgressPolicy | undefined,
  customCategoryNames: Iterable<string>,
  scope: EgressScope = 'cascade',
): EgressCategoryIssue[] {
  const custom = new Set([...customCategoryNames].map((n) => n.toLowerCase()));
  const issues: EgressCategoryIssue[] = [];
  const kinds: [('geosite' | 'geoip'), string, string[] | undefined][] = [];
  for (const rule of policy ?? []) {
    kinds.length = 0;
    kinds.push(['geosite', GEO_SITE_ARTIFACT, rule.geosite]);
    kinds.push(['geoip', GEO_IP_ARTIFACT, rule.geoip]);
    for (const [kind, extFile, arr] of kinds) {
      for (const entry of arr ?? []) {
        const name = standardName(entry, kind);
        if (name === null) continue; // already-qualified matcher, not our concern
        if (!CATEGORY_TOKEN.test(name)) {
          issues.push({ matcher: entry, reason: `not a valid ${kind} category name` });
          continue;
        }
        // The category identity is the name WITHOUT a leading `!` (negation):
        // `!runet` / `!cn` still reference the `runet` / `cn` category. Match on
        // the bare name so a negated ref to a custom category (or an unknown
        // geoip code) is caught the same as the un-negated form.
        const bare = name.replace(/^!/, '');
        if (custom.has(bare.toLowerCase())) {
          if (scope === 'node') {
            // The node scope cannot reference a custom category AT ALL: the file
            // it lives in reaches a node only as a cascade fragment, which is
            // why NodeEgressPolicySchema refuses `ext:` outright. Suggesting the
            // ext form here would send an operator to a form the next validator
            // rejects, so say what is actually true.
            issues.push({
              matcher: entry,
              reason:
                `"${bare}" is a custom category from your geo sources, and a node's own policy ` +
                `cannot use one: the panel delivers the custom .dat only to a cascade member. ` +
                `A bare ${kind}: resolves against the node's bundled databases, which do not ` +
                `contain it, so this rule would be silently dropped. Put the split on the ` +
                `cascade position instead, or spell the domains out here.`,
            });
            continue;
          }
          issues.push({
            matcher: entry,
            reason:
              `"${bare}" is a custom category from your geo sources - reference it as a custom ` +
              // Suggest the ext form with the negation preserved (`name`, not
              // `bare`): for geoip, xray honours the reverse-match `ext:file:!cat`,
              // so a negated ref keeps its "everything except" meaning instead of
              // silently inverting. (geosite has no ext-domain negation, so a `!`
              // there is caught fail-closed by the node's xray -test preflight.)
              `category (the node receives it as ext:${extFile}:${name}), not as a bare ${kind}:. ` +
              `A bare ${kind}: resolves against the node's bundled databases, which do not ` +
              `contain your custom category, so the rule would be silently dropped.`,
          });
          continue;
        }
        if (kind === 'geoip' && !GEOIP_CATEGORIES.has(bare.toLowerCase())) {
          issues.push({
            matcher: entry,
            reason:
              `geoip:${name} is not a known country code or standard geoip category - check ` +
              `spelling, or add it as a custom category.`,
          });
        }
      }
    }
  }
  return issues;
}

export class EgressCategoryError extends Error {
  constructor(readonly issues: EgressCategoryIssue[]) {
    super(
      `egress policy references unusable geo categories: ${issues
        .map((i) => `${i.matcher} (${i.reason})`)
        .join('; ')}`,
    );
    this.name = 'EgressCategoryError';
  }
}

/** Throw EgressCategoryError (mapped to 400) when a policy has authoring
 *  mistakes in its standard category matchers. No-op for an absent/clean policy. */
export function assertEgressCategories(
  policy: EgressPolicy | undefined,
  customCategoryNames: Iterable<string>,
  scope: EgressScope = 'cascade',
): void {
  const issues = validateEgressCategories(policy, customCategoryNames, scope);
  if (issues.length > 0) throw new EgressCategoryError(issues);
}
