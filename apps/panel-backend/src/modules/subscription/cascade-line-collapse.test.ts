import { describe, expect, it } from 'vitest';
import { collapseCascadeLines } from './subscription.service.js';
import { autoRouteTag, routeTag } from '../cascades/cascade.config.js';
import type { SubscriptionEndpoint } from './subscription.formats.js';

/**
 * A cascade shows one line per profile, however many ways in the subscriber has.
 *
 * Two entries used to mean every line twice - two rows called Auto, two called
 * "ru → NL" - and when the entries shared a transport the duplicates were
 * labelled identically. The only thing differing between them is which of our
 * machines the traffic enters through, which a subscriber cannot judge.
 */
const CASCADE = 'c-1';
const OTHER = 'c-2';
const NL = routeTag(0, 0);
const SE = routeTag(0, 1);
const AUTO = autoRouteTag(0);

function entry(over: Partial<SubscriptionEndpoint> = {}): SubscriptionEndpoint {
  return {
    protocol: 'xray',
    subprotocol: 'vless',
    nodeName: 'ru-01',
    host: 'ru-01.example',
    port: 443,
    network: 'xhttp',
    uuid: '00000000-0000-0000-0000-000000000000',
    uri: 'vless://x@ru-01.example:443',
    ...over,
  } as SubscriptionEndpoint;
}

const lines = (cascadeId = CASCADE) => [
  { label: '⚡ ru → Auto', tag: AUTO, cascadeId },
  { label: '🇳🇱 ru → NL', tag: NL, cascadeId },
  { label: '🇸🇪 ru → SE', tag: SE, cascadeId },
];

/** The shape on the stand: two entries, same transport, same three lines. */
function pool(entries = 2): SubscriptionEndpoint[] {
  return Array.from({ length: entries }, (_, i) =>
    entry({
      nodeName: `ru-0${i + 1}`,
      host: `ru-0${i + 1}.example`,
      cascadeExits: lines(),
    }),
  );
}

const labels = (endpoints: SubscriptionEndpoint[]): string[] =>
  endpoints.flatMap((e) => (e.cascadeExits ?? []).map((x) => x.label));

const holderOf = (endpoints: SubscriptionEndpoint[], tag: number): string | undefined =>
  endpoints.find((e) => (e.cascadeExits ?? []).some((x) => x.tag === tag))?.nodeName;

describe('a pooled cascade in a list of share links', () => {
  it('shows each line exactly once', () => {
    const endpoints = pool();
    collapseCascadeLines(endpoints, 'user-1');
    expect(labels(endpoints).sort()).toEqual(['⚡ ru → Auto', '🇳🇱 ru → NL', '🇸🇪 ru → SE'].sort());
  });

  it('deals the lines across the entries instead of piling them on one', () => {
    // The pool exists for redundancy and spread. All three lines on one entry
    // would waste both, and one blocked entry would take the whole cascade with
    // it.
    const endpoints = pool();
    collapseCascadeLines(endpoints, 'user-1');
    const used = new Set(endpoints.filter((e) => (e.cascadeExits ?? []).length > 0).map((e) => e.nodeName));
    expect(used.size).toBe(2);
  });

  it('keeps every line reachable when an entry offers only some of them', () => {
    // Squad ACLs are resolved per entry, so two entries of one pool can
    // legitimately carry different sets. A line must be dealt to an entry that
    // actually has it, never dropped for lack of one.
    const endpoints = [
      entry({ cascadeExits: [{ label: '🇳🇱 ru → NL', tag: NL, cascadeId: CASCADE }] }),
      entry({ nodeName: 'ru-02', host: 'ru-02.example', cascadeExits: lines() }),
    ];
    collapseCascadeLines(endpoints, 'user-2');
    expect(labels(endpoints).sort()).toEqual(['⚡ ru → Auto', '🇳🇱 ru → NL', '🇸🇪 ru → SE'].sort());
  });

  it('does not move a subscriber between refreshes', () => {
    // A move drops every live connection on their router, for no gain.
    const first = pool();
    const second = pool();
    collapseCascadeLines(first, 'user-3');
    collapseCascadeLines(second, 'user-3');
    for (const tag of [AUTO, NL, SE]) {
      expect(holderOf(first, tag)).toBe(holderOf(second, tag));
    }
  });

  it('does not put every subscriber on the same entry', () => {
    const holders = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const endpoints = pool();
      collapseCascadeLines(endpoints, `user-${i}`);
      holders.add(holderOf(endpoints, NL)!);
    }
    expect(holders.size).toBe(2);
  });

  it('leaves everybody else in place when a direction is added', () => {
    // Assignment is by TAG, not by position in the list, so a new direction
    // takes an entry without reshuffling the lines already handed out. The
    // opposite would move users on an unrelated edit to the cascade.
    const before = pool();
    collapseCascadeLines(before, 'user-5');
    const after = pool();
    for (const e of after) {
      e.cascadeExits!.push({ label: '🇩🇪 ru → DE', tag: routeTag(0, 2), cascadeId: CASCADE });
    }
    collapseCascadeLines(after, 'user-5');
    for (const tag of [AUTO, NL, SE]) {
      expect(holderOf(after, tag)).toBe(holderOf(before, tag));
    }
  });

  it('treats two cascades separately', () => {
    const endpoints = pool();
    for (const e of endpoints) e.cascadeExits!.push(...lines(OTHER));
    collapseCascadeLines(endpoints, 'user-6');
    expect(labels(endpoints).filter((l) => l === '⚡ ru → Auto')).toHaveLength(2);
    const perCascade = endpoints.flatMap((e) =>
      (e.cascadeExits ?? []).map((x) => `${x.cascadeId}|${x.tag}`),
    );
    expect(new Set(perCascade).size).toBe(perCascade.length);
  });

  it('removes an entry it has emptied instead of leaving it in the list', () => {
    // An endpoint with an empty exit list is emitted as an ordinary direct
    // server: the subscriber connects to a cascade ENTRY as a plain node and
    // egresses in the entry country while believing otherwise. With more entries
    // than lines, dealing them out empties one.
    const endpoints = pool(4);
    for (const e of endpoints) {
      e.cascadeExits = [{ label: '🇳🇱 ru → NL', tag: NL, cascadeId: CASCADE }];
    }
    collapseCascadeLines(endpoints, 'user-8');
    expect(endpoints).toHaveLength(1);
    expect(labels(endpoints)).toEqual(['🇳🇱 ru → NL']);
  });

  it('leaves a single entry untouched', () => {
    const endpoints = pool(1);
    collapseCascadeLines(endpoints, 'user-9');
    expect(labels(endpoints)).toHaveLength(3);
  });

  it('ignores endpoints that are not cascade entries', () => {
    const endpoints = [entry(), entry({ nodeName: 'de-01' })];
    collapseCascadeLines(endpoints, 'user-1');
    expect(endpoints).toHaveLength(2);
    expect(endpoints.every((e) => e.cascadeExits === undefined)).toBe(true);
  });
});
