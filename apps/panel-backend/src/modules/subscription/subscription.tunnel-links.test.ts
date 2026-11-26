import { describe, expect, it } from 'vitest';
import type { SubscriptionEndpoint } from './subscription.formats.js';
import { endpointId } from './endpoint-identity.js';
import { tunnelConfigUrls, tunnelQuery, wantsTunnelPreselect } from './subscription.tunnel-links.js';

const SUB = 'https://panel.example.com/sub/tok';
const tunnel = (o: Record<string, unknown>) =>
  ({ protocol: 'amneziawg', nodeName: 'awg-1', host: 'h', port: 1, key: 'k1', ...o }) as unknown as SubscriptionEndpoint;

describe('tunnelConfigUrls', () => {
  it('AmneziaWG: both files by the endpoint id, device from the second on', () => {
    const e = tunnel({});
    const id = endpointId(e);
    expect(tunnelConfigUrls(SUB, e)).toEqual({
      wgconf: `${SUB}?format=wgconf&node=${id}`,
      amneziavpn: `${SUB}?format=amneziavpn&node=${id}`,
    });
    expect(tunnelConfigUrls(SUB, tunnel({ deviceIndex: 2 }))!.wgconf).toMatch(/&device=2$/);
  });

  it('plain WireGuard: the .conf only, kind named as 9.2 made it', () => {
    const e = tunnel({ protocol: 'wireguard' });
    expect(tunnelConfigUrls(SUB, e)).toEqual({
      wgconf: `${SUB}?protocols=wireguard&format=wgconf&node=${endpointId(e)}`,
    });
  });

  it('names no file a host is switched off for, and nothing for what is not a tunnel', () => {
    expect(tunnelConfigUrls(SUB, tunnel({ disableForFormats: ['wgconf'] }))).toEqual({
      amneziavpn: expect.stringContaining('format=amneziavpn'),
    });
    expect(tunnelConfigUrls(SUB, tunnel({ disableForFormats: ['wgconf', 'amneziavpn'] }))).toBeUndefined();
    expect(tunnelConfigUrls(SUB, tunnel({ protocol: 'xray' }))).toBeUndefined();
  });
});

describe('the link vocabulary', () => {
  it('a node (and device) is a preselection; protocols or a device alone is not', () => {
    expect(wantsTunnelPreselect({ node: 'abcd1234' })).toBe(true);
    expect(wantsTunnelPreselect({})).toBe(false);
    expect(tunnelQuery({ nodeName: 'a b', id: 'x', device: 3 })).toBe('node=x&device=3');
    expect(tunnelQuery({ nodeName: 'a b' })).toBe('node=a%20b');
  });
});
