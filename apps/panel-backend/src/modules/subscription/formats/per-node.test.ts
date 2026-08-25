// The per-node artefact list, which both install surfaces walk.
//
// Covered only indirectly until now, through the pages that render it. What
// makes it worth its own test is that both surfaces have to walk it the SAME
// way: a buyer following the shop's screen and a buyer following ours must be
// handed the same servers, in the same order, under the same names.

import { describe, expect, it } from 'vitest';
import { collectMtprotoNodes, collectWgNodes, tunnelConfigUrls } from './per-node.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';

function awg(nodeName: string): SubscriptionEndpoint {
  return {
    protocol: 'amneziawg',
    nodeName,
    host: 'n1.example.com',
    port: 51820,
    privateKey: 'SKVflqhBtd448MZChs0R4Ppd+1Drtigt+XWs/7OjTlA=',
    allowedIp: '10.77.0.9/32',
    serverPublicKey: 'BQ6TIcR/TaTqtY4slJvnVj0I95pkC3z7t4HA54i8qVA=',
    jc: 4, jmin: 64, jmax: 128, s1: 32, s2: 56, s3: 32, s4: 16,
    h1: 100, h2: 200, h3: 300, h4: 400,
    i1: '', i2: '', i3: '', i4: '', i5: '',
    uri: '',
  } as unknown as SubscriptionEndpoint;
}

function wg(nodeName: string): SubscriptionEndpoint {
  return { ...awg(nodeName), protocol: 'wireguard' } as unknown as SubscriptionEndpoint;
}

function mt(nodeName: string, tmeUri: string): SubscriptionEndpoint {
  return {
    protocol: 'mtproto',
    nodeName,
    host: 'mt.example.com',
    port: 8888,
    secret: 'ee00',
    domain: 'www.cloudflare.com',
    uri: 'tg://proxy?server=mt.example.com',
    tmeUri,
  } as unknown as SubscriptionEndpoint;
}

const SUB = 'https://panel.example/sub/tok';

describe('collectWgNodes', () => {
  it('gives one entry per node, in subscription order, deduped by name', () => {
    const nodes = collectWgNodes([awg('nl-1'), awg('de-2'), awg('nl-1')], 'amneziawg');
    expect(nodes.map((n) => n.nodeName)).toEqual(['nl-1', 'de-2']);
  });

  it('builds the tunnel file, and the AmneziaVPN key only for AmneziaWG', () => {
    const [a] = collectWgNodes([awg('nl-1')], 'amneziawg');
    expect(a!.conf).toContain('[Interface]');
    // The obfuscation is what makes it AmneziaWG rather than WireGuard.
    expect(a!.conf).toContain('Jc = 4');
    expect(a!.vpnKey).toMatch(/^vpn:\/\//);

    const [w] = collectWgNodes([wg('nl-1')], 'wireguard');
    expect(w!.conf).toContain('[Interface]');
    // Stock WireGuard has no key form; offering one would be inventing an
    // import path its clients do not have.
    expect(w!.vpnKey).toBeNull();
    expect(w!.conf).not.toContain('Jc =');
  });

  it('keeps the two flavours apart', () => {
    const both = [awg('nl-1'), wg('de-2')];
    expect(collectWgNodes(both, 'amneziawg').map((n) => n.nodeName)).toEqual(['nl-1']);
    expect(collectWgNodes(both, 'wireguard').map((n) => n.nodeName)).toEqual(['de-2']);
  });
});

describe('collectMtprotoNodes', () => {
  it('gives one t.me link per node and drops an endpoint that has none', () => {
    const nodes = collectMtprotoNodes([
      mt('nl-1', 'https://t.me/proxy?server=a'),
      mt('de-2', ''),
      mt('nl-1', 'https://t.me/proxy?server=a'),
    ]);
    expect(nodes).toEqual([{ nodeName: 'nl-1', tmeUri: 'https://t.me/proxy?server=a' }]);
  });
});

describe('tunnelConfigUrls', () => {
  it('escapes a node name that is not URL-safe', () => {
    // Real node names carry a flag emoji and a space — "🇳🇱 n-lab-3". An
    // unescaped one produces a link that resolves to a different node, or to
    // none, and the download is empty with nothing to say why.
    const urls = tunnelConfigUrls(awg('🇳🇱 n-lab-3'), SUB)!;
    expect(urls['wgconf']).toContain('node=%F0%9F%87%B3%F0%9F%87%B1%20n-lab-3');
    expect(urls['wgconf']).not.toContain('node=🇳🇱');
    expect(urls['amneziavpn']).toContain('format=amneziavpn');
  });

  it('offers the AmneziaVPN key form only where it exists', () => {
    expect(Object.keys(tunnelConfigUrls(awg('nl-1'), SUB)!).sort()).toEqual([
      'amneziavpn',
      'wgconf',
    ]);
    expect(Object.keys(tunnelConfigUrls(wg('nl-1'), SUB)!)).toEqual(['wgconf']);
  });

  it('says nothing about an endpoint whose share-link is the answer', () => {
    expect(tunnelConfigUrls(mt('nl-1', 'https://t.me/proxy?server=a'), SUB)).toBeUndefined();
  });
});
