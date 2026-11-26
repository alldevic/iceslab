import { GEO_BUILTIN_NAMES } from '@iceslab/shared';
import { config } from '../../config.js';
import { prisma } from '../../prisma.js';
import { singboxAvailable } from '../../lib/util/singbox-bin.js';
import { geoArtifactBaseUrl } from './geo-public-url.js';

/**
 * What the panel can hand its clients' geo downloads RIGHT NOW (milestone 10.5):
 * the one answer the subscription formats ask before they point a client at the
 * panel instead of GitHub or a CDN. null while GEO_SELF_HOST is off, which is
 * every format as the base wrote it. A client that is sent to an address the
 * panel then 404s does not start (sing-box) or has no geo (mihomo), so nothing
 * is claimed that is not there: a set counts when it has a verified version that
 * is not broken (the rule geo-public.routes.ts serves by), a `.srs` only when a
 * sing-box is there to compile it, and a tag only when the set's version has it.
 * Milestones 10.6 and 12.5 read the same answer.
 */
export interface SelfHostedGeo {
  /** `<origin>/geo/<token>`; append `/<file name>`. */
  baseUrl: string;
  /** The built-in sets: lower-case tag names of the served version, null when the set is not served. */
  tags: { geosite: ReadonlySet<string> | null; geoip: ReadonlySet<string> | null };
  /** A sing-box to compile `.srs` is there. */
  srs: boolean;
}

/** A served set: its identity and the lower-case tag names of its current version. */
export interface ServedSet {
  name: string;
  kind: string;
  sourceType: string;
  sha256: string;
  tags: ReadonlySet<string>;
}

// Tag names by version sha256: the content under it never changes. The tags
// are a JSON column of a thousand names or more, not read on every request.
const TAGS_MAX = 64;
const tagMemo = new Map<string, ReadonlySet<string>>();

function memoTags(sha256: string, tags: ReadonlySet<string>): void {
  tagMemo.delete(sha256);
  tagMemo.set(sha256, tags);
  for (const k of tagMemo.keys()) {
    if (tagMemo.size <= TAGS_MAX) break;
    tagMemo.delete(k);
  }
}

/** The set `name` when it has a verified version and is not broken, with its tag names; else null. */
export async function servedSet(name: string): Promise<ServedSet | null> {
  const s = await prisma.geoSet.findUnique({
    where: { name },
    select: { id: true, name: true, kind: true, sourceType: true, status: true, current: { select: { sha256: true } } },
  });
  if (!s?.current || s.status === 'broken') return null;
  const sha256 = s.current.sha256;
  let tags = tagMemo.get(sha256);
  if (!tags) {
    const v = await prisma.geoSetVersion.findFirst({ where: { sha256, geoSetId: s.id }, select: { tags: true } });
    tags = new Set(((v?.tags as { name: string }[] | null) ?? []).map((t) => t.name.toLowerCase()));
    memoTags(sha256, tags);
  }
  return { name: s.name, kind: s.kind, sourceType: s.sourceType, sha256, tags };
}

/** For tests. */
export function resetServedTagMemo(): void {
  tagMemo.clear();
}

export async function selfHostedGeo(): Promise<SelfHostedGeo | null> {
  if (!config.GEO_SELF_HOST) return null;
  const [geosite, geoip] = await Promise.all([servedSet(GEO_BUILTIN_NAMES.geosite), servedSet(GEO_BUILTIN_NAMES.geoip)]);
  return {
    baseUrl: geoArtifactBaseUrl(),
    tags: { geosite: geosite?.tags ?? null, geoip: geoip?.tags ?? null },
    srs: singboxAvailable(),
  };
}
