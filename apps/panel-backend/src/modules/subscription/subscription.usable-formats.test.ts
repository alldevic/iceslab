import { describe, it, expect } from 'vitest';
import { carriedFormats, usableFormats } from './subscription.usable-formats.js';
import type { SubscriptionEndpoint } from './subscription.formats.js';

function xray(over: Record<string, unknown> = {}): SubscriptionEndpoint {
  return {
    protocol: 'xray',
    subprotocol: 'vless',
    nodeName: 'n1',
    network: 'raw',
    securityLayer: 'default',
    uuid: '00000000-0000-0000-0000-000000000000',
    uri: 'vless://x@h:443',
    ...over,
  } as unknown as SubscriptionEndpoint;
}

describe('usableFormats', () => {
  it('leaves the file in the carried list but takes sing-box out of the usable one on an XHTTP-only fleet', () => {
    const fleet = [xray({ network: 'xhttp' }), xray({ network: 'xhttp', nodeName: 'n2' })];
    expect(carriedFormats(fleet)).toContain('singbox');
    const usable = usableFormats(fleet);
    expect(usable).not.toContain('singbox');
    // The ones that dial XHTTP stay.
    expect(usable).toContain('xrayjson');
    expect(usable).toContain('plain');
    expect(usable).toContain('mihomo');
  });

  it('keeps sing-box when one server is something it can dial', () => {
    expect(usableFormats([xray({ network: 'xhttp' }), xray({ network: 'raw', nodeName: 'n2' })])).toContain('singbox');
  });

  it('answers empty for no endpoints', () => {
    expect(usableFormats([])).toEqual([]);
  });

  it('honours the switch of a host for a format', () => {
    const fleet = [xray({ disableForFormats: ['singbox'] })];
    expect(usableFormats(fleet)).not.toContain('singbox');
    expect(usableFormats(fleet)).toContain('xrayjson');
  });

  it('does not judge a non-xray endpoint by the transport table', () => {
    const tuic = { protocol: 'tuic', nodeName: 'n1', uri: 'tuic://x' } as unknown as SubscriptionEndpoint;
    expect(usableFormats([tuic])).toEqual(expect.arrayContaining(['singbox', 'mihomo', 'plain']));
    expect(usableFormats([tuic])).not.toContain('xrayjson');
  });

  it('leaves WireGuard to the per-node files: plain carries nothing for it', () => {
    const wg = { protocol: 'wireguard', nodeName: 'n1', uri: '' } as unknown as SubscriptionEndpoint;
    const usable = usableFormats([wg]);
    expect(usable).toContain('wgconf');
    expect(usable).not.toContain('plain');
  });
  // Cases of the fork's format-usable.test.ts that the base had no unit for.
  it('gives a tunnel-only buyer no subscription format, only the tunnel file', () => {
    const awg = { protocol: 'amneziawg', nodeName: 'n1', uri: '' } as unknown as SubscriptionEndpoint;
    const usable = usableFormats([awg]);
    for (const f of ['plain', 'mihomo', 'singbox', 'xrayjson'] as const) expect(usable, f).not.toContain(f);
    expect(usable).toContain('wgconf');
  });

  it('judges a tunnel next to a proxy on the proxy: it does not take the proxy formats away', () => {
    const awg = { protocol: 'amneziawg', nodeName: 'n2', uri: '' } as unknown as SubscriptionEndpoint;
    const usable = usableFormats([awg, xray()]);
    expect(usable).toContain('plain');
    expect(usable).toContain('singbox');
    expect(usable).toContain('wgconf');
  });
});
