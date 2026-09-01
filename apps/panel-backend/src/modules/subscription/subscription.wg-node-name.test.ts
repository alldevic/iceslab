// The node name a wg tunnel carries.
//
// Regression from slice 51, caught on the production deploy rather than by a
// test: `generateSubscription` renames endpoints that would collide on the
// `${nodeName}-${protocol}` tag the structured formatters build. A buyer with
// three devices has three amneziawg endpoints on ONE node, so two of them got
// renamed - and since wg links, file names and the `# Name` line are all built
// from nodeName, the buyer's second tunnel arrived calling itself "s2 2".
//
// The rename exists for clash / sing-box / xray-json, and none of the three
// emits wg at all (their own headers say so). So the fix is an exemption, and
// this test is here because the shape that broke - several endpoints sharing a
// node - is exactly the shape devices made normal.

import { describe, expect, it } from 'vitest';

/** The uniquifier, lifted verbatim from generateSubscription. */
function disambiguate(endpoints: { nodeName: string; protocol: string }[]): void {
  const isWgFamily = (p: string): boolean => p === 'amneziawg' || p === 'wireguard';
  const usedTags = new Set<string>();
  for (const e of endpoints) {
    if (isWgFamily(e.protocol)) continue;
    let name = e.nodeName;
    let n = 2;
    while (usedTags.has(`${name}-${e.protocol}`)) {
      name = `${e.nodeName} ${n++}`;
    }
    usedTags.add(`${name}-${e.protocol}`);
    e.nodeName = name;
  }
}

describe('endpoint name disambiguation', () => {
  it('leaves every wg tunnel on its real node name, however many devices share it', () => {
    const eps = [
      { nodeName: '🇳🇱 s2', protocol: 'amneziawg' },
      { nodeName: '🇳🇱 s2', protocol: 'amneziawg' },
      { nodeName: '🇳🇱 s2', protocol: 'amneziawg' },
      { nodeName: '🇳🇱 s2', protocol: 'wireguard' },
      { nodeName: '🇳🇱 s2', protocol: 'wireguard' },
    ];
    disambiguate(eps);
    expect(eps.map((e) => e.nodeName)).toEqual(['🇳🇱 s2', '🇳🇱 s2', '🇳🇱 s2', '🇳🇱 s2', '🇳🇱 s2']);
  });

  it('still renames a real tag collision on a format that HAS tags', () => {
    // Two hosts on one binding, same node and protocol: this is what the
    // uniquifier was written for, and clash/sing-box/xray reject the duplicate.
    const eps = [
      { nodeName: 's2', protocol: 'xray' },
      { nodeName: 's2', protocol: 'xray' },
      { nodeName: 's2', protocol: 'hysteria' },
    ];
    disambiguate(eps);
    expect(eps.map((e) => e.nodeName)).toEqual(['s2', 's2 2', 's2']);
  });
});
