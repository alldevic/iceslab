import { describe, expect, it } from 'vitest';
import { keepOneAutoPerCascade } from './subscription.service.js';
import { autoRouteTag, routeTag } from '../cascades/cascade.config.js';
import type { SubscriptionEndpoint } from './subscription.formats.js';

/**
 * Auto is one line, however many ways into the cascade a subscriber has.
 *
 * Two entries meant two rows both called Auto, and when the entries shared a
 * transport the two were labelled identically: the list asked the subscriber to
 * choose between two things named "let the server choose". The balancing that
 * matters is untouched by this - the EXIT is picked at the entry node, per
 * connection - so all this decides is which way in the single row uses.
 */
const CASCADE = 'c-1';
const OTHER = 'c-2';

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

/** Two entries of one pool, both offering Auto plus both directions. */
function pool(): SubscriptionEndpoint[] {
  const exits = (cascadeId: string) => [
    { label: '⚡ ru → Auto', tag: autoRouteTag(0), cascadeId },
    { label: '🇳🇱 ru → NL', tag: routeTag(0, 0), cascadeId },
    { label: '🇸🇪 ru → SE', tag: routeTag(0, 1), cascadeId },
  ];
  return [
    entry({ cascadeExits: exits(CASCADE) }),
    entry({ nodeName: 'ru-02', host: 'ru-02.example', cascadeExits: exits(CASCADE) }),
  ];
}

const labels = (endpoints: SubscriptionEndpoint[]): string[] =>
  endpoints.flatMap((e) => (e.cascadeExits ?? []).map((x) => x.label));

describe('the Auto line in a list of share links', () => {
  it('survives on exactly one way in', () => {
    const endpoints = pool();
    keepOneAutoPerCascade(endpoints, 'user-1');
    expect(labels(endpoints).filter((l) => l.includes('Auto'))).toHaveLength(1);
  });

  it('leaves every direction alone on both entries', () => {
    // The directions ARE a choice: a subscriber picks a country there, and both
    // ways in have to keep offering it.
    const endpoints = pool();
    keepOneAutoPerCascade(endpoints, 'user-1');
    expect(labels(endpoints).filter((l) => l.includes('NL'))).toHaveLength(2);
    expect(labels(endpoints).filter((l) => l.includes('SE'))).toHaveLength(2);
  });

  it('keeps the same way in across refreshes', () => {
    // A subscription refresh that moves someone's Auto row to another host drops
    // their live connections for no reason. Same user, same answer.
    const first = pool();
    const second = pool();
    keepOneAutoPerCascade(first, 'user-1');
    keepOneAutoPerCascade(second, 'user-1');
    const holder = (list: SubscriptionEndpoint[]) =>
      list.find((e) => (e.cascadeExits ?? []).some((x) => x.label.includes('Auto')))!.nodeName;
    expect(holder(first)).toBe(holder(second));
  });

  it('does not put every subscriber on the same way in', () => {
    // The pool exists to spread people. If Auto always landed on the first
    // entry, everyone using Auto would pile onto it while the other idles.
    const holders = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const endpoints = pool();
      keepOneAutoPerCascade(endpoints, `user-${i}`);
      holders.add(
        endpoints.find((e) => (e.cascadeExits ?? []).some((x) => x.label.includes('Auto')))!.nodeName,
      );
    }
    expect(holders.size).toBe(2);
  });

  it('drops the Auto variants of a policy along with it', () => {
    // "Auto" and "Auto · no ads" are the same row wearing two hats; splitting
    // them across entries would put the pair back in the list.
    const endpoints = pool();
    for (const e of endpoints) {
      e.cascadeExits!.push({ label: '⚡ ru → Auto · Без рекламы', tag: autoRouteTag(1), cascadeId: CASCADE });
    }
    keepOneAutoPerCascade(endpoints, 'user-7');
    const withAuto = endpoints.filter((e) => (e.cascadeExits ?? []).some((x) => x.label.includes('Auto')));
    expect(withAuto).toHaveLength(1);
    expect(labels(withAuto).filter((l) => l.includes('Auto'))).toHaveLength(2);
  });

  it('treats two cascades separately', () => {
    // One Auto each, not one in total.
    const endpoints = pool();
    endpoints[0]!.cascadeExits!.push({ label: '⚡ de → Auto', tag: autoRouteTag(0), cascadeId: OTHER });
    endpoints[1]!.cascadeExits!.push({ label: '⚡ de → Auto', tag: autoRouteTag(0), cascadeId: OTHER });
    keepOneAutoPerCascade(endpoints, 'user-3');
    expect(labels(endpoints).filter((l) => l === '⚡ ru → Auto')).toHaveLength(1);
    expect(labels(endpoints).filter((l) => l === '⚡ de → Auto')).toHaveLength(1);
  });

  it('never strips an endpoint down to no profiles at all', () => {
    // An entry with an empty profile list is emitted as an ordinary direct
    // server, and the subscriber then egresses in the ENTRY country while their
    // client shows a cascade. Keeping a duplicate Auto row is the lesser evil.
    const endpoints = [
      entry({ cascadeExits: [{ label: '⚡ ru → Auto', tag: autoRouteTag(0), cascadeId: CASCADE }] }),
      entry({
        nodeName: 'ru-02',
        host: 'ru-02.example',
        cascadeExits: [{ label: '⚡ ru → Auto', tag: autoRouteTag(0), cascadeId: CASCADE }],
      }),
    ];
    keepOneAutoPerCascade(endpoints, 'user-9');
    expect(endpoints.every((e) => (e.cascadeExits ?? []).length > 0)).toBe(true);
  });

  it('leaves a lone entry untouched', () => {
    const endpoints = [entry({ cascadeExits: [{ label: '⚡ ru → Auto', tag: autoRouteTag(0), cascadeId: CASCADE }] })];
    keepOneAutoPerCascade(endpoints, 'user-1');
    expect(labels(endpoints)).toEqual(['⚡ ru → Auto']);
  });

  it('ignores endpoints that are not cascade entries', () => {
    const endpoints = [entry(), entry({ nodeName: 'de-01' })];
    keepOneAutoPerCascade(endpoints, 'user-1');
    expect(endpoints.every((e) => e.cascadeExits === undefined)).toBe(true);
  });
});
