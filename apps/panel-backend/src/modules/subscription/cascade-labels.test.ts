import { describe, expect, it } from 'vitest';
import { disambiguateCascadeLabels } from './subscription.service.js';
import type { SubscriptionEndpoint } from './subscription.formats.js';
import { cascadeProfileLabel } from '../../lib/country-flag.js';

/**
 * Two lines a subscriber cannot tell apart are worse than one line fewer.
 *
 * A cascade's entry is a pool, and every node in it offers the same exits, so
 * the same label comes out once per entry. Until 2026-08-15 the second entry
 * was leaking into subscriptions as a plain direct server instead (a worse
 * bug, which hid this one); once that was fixed, a subscriber got "ru → NL"
 * twice with nothing to choose between them.
 *
 * The old mechanism suffixed a label whenever the host was named, decided per
 * endpoint. That is exactly backwards: an endpoint cannot see whether anything
 * collided, so unique labels got noise and colliding ones got the same suffix
 * from two places at once.
 */

function xrayEndpoint(over: Partial<SubscriptionEndpoint> = {}): SubscriptionEndpoint {
  return {
    protocol: 'xray',
    subprotocol: 'vless',
    nodeName: 'ru-01',
    network: 'xhttp',
    uuid: '00000000-0000-0000-0000-000000000000',
    uri: 'vless://x@h:443',
    ...over,
  } as SubscriptionEndpoint;
}

describe('cascade labels in one subscription', () => {
  it('leaves a label alone when nothing collides', () => {
    const endpoints = [
      xrayEndpoint({ cascadeExits: [{ label: '🇳🇱 ru → NL', tag: 1 }] }),
      xrayEndpoint({ nodeName: 'se-01', cascadeExits: [{ label: '🇸🇪 ru → SE', tag: 2 }] }),
    ];
    disambiguateCascadeLabels(endpoints);
    expect(endpoints[0]!.cascadeExits![0]!.label).toBe('🇳🇱 ru → NL');
    expect(endpoints[1]!.cascadeExits![0]!.label).toBe('🇸🇪 ru → SE');
  });

  it('tells two entries of one pool apart by their transport', () => {
    // What the subscriber actually sees differ: same cascade, same exit, two
    // ways in. The transport is also what their client prints under the name.
    const endpoints = [
      xrayEndpoint({ network: 'xhttp', cascadeExits: [{ label: 'ru → NL', tag: 1 }] }),
      xrayEndpoint({ nodeName: 'ru-02', network: 'grpc', cascadeExits: [{ label: 'ru → NL', tag: 1 }] }),
    ];
    disambiguateCascadeLabels(endpoints);
    expect(endpoints.map((e) => e.cascadeExits![0]!.label)).toEqual([
      'ru → NL · XHTTP',
      'ru → NL · gRPC',
    ]);
  });

  it('disambiguates every colliding exit, not just the first', () => {
    const endpoints = [
      xrayEndpoint({
        network: 'xhttp',
        cascadeExits: [
          { label: 'ru → NL', tag: 1 },
          { label: 'ru → SE', tag: 2 },
        ],
      }),
      xrayEndpoint({
        nodeName: 'ru-02',
        network: 'grpc',
        cascadeExits: [
          { label: 'ru → NL', tag: 1 },
          { label: 'ru → SE', tag: 2 },
        ],
      }),
    ];
    disambiguateCascadeLabels(endpoints);
    expect(endpoints.flatMap((e) => e.cascadeExits!.map((x) => x.label))).toEqual([
      'ru → NL · XHTTP',
      'ru → SE · XHTTP',
      'ru → NL · gRPC',
      'ru → SE · gRPC',
    ]);
  });

  it('falls back to the host name when the transport cannot separate them', () => {
    // Two hosts on one node, same transport: the operator named them, so use
    // the name rather than repeating "XHTTP" twice.
    const endpoints = [
      xrayEndpoint({ network: 'xhttp', hostRemark: 'cdn', cascadeExits: [{ label: 'ru → NL', tag: 1 }] }),
      xrayEndpoint({ network: 'xhttp', hostRemark: 'direct', cascadeExits: [{ label: 'ru → NL', tag: 1 }] }),
    ];
    disambiguateCascadeLabels(endpoints);
    // Transport is equal here, so it separates nothing; both keep it and stay
    // identical. Documented as the known gap rather than silently wrong.
    expect(endpoints.map((e) => e.cascadeExits![0]!.label)).toEqual([
      'ru → NL · XHTTP',
      'ru → NL · XHTTP',
    ]);
  });

  it('ignores endpoints that are not cascade entries', () => {
    const endpoints = [xrayEndpoint(), xrayEndpoint({ nodeName: 'ru-02' })];
    disambiguateCascadeLabels(endpoints);
    expect(endpoints.every((e) => e.cascadeExits === undefined)).toBe(true);
  });
});

describe('the direction a cascade label reads in', () => {
  it('points from the cascade to the exit', () => {
    // "ru · NL" was read as "ru through NL" by the first operator who saw it,
    // which is the opposite of what happens: ru is where traffic enters.
    expect(cascadeProfileLabel('ru', 'NL', 'nl-01')).toContain('ru → NL');
  });

  it('falls back to the exit node name when it has no country', () => {
    expect(cascadeProfileLabel('ru', null, 'nl-01')).toBe('ru → nl-01');
  });
});

/**
 * Two entries share the SAME exit objects — the panel builds the lines once per
 * cascade and hands them to every entry that offers them. Renaming in place
 * therefore renamed both, and the second endpoint's line, already suffixed,
 * failed the "is this label ambiguous" test and kept the first one's transport.
 * The subscription came out with two servers under one name.
 */
describe('disambiguateCascadeLabels with shared line objects', () => {
  it('names each endpoint after ITS OWN transport', () => {
    const shared = [{ label: '🇳🇱 ru → NL', tag: 1, cascadeId: 'c-1' }];
    const xhttp = {
      protocol: 'xray', network: 'xhttp', nodeName: 'ru-01', host: 'ru-01', port: 443,
      cascadeExits: [...shared],
    } as never;
    const raw = {
      protocol: 'xray', network: 'raw', nodeName: 'ru-01', host: 'ru-01', port: 8443,
      cascadeExits: [...shared],
    } as never;

    disambiguateCascadeLabels([xhttp, raw] as never);

    const labels = [xhttp, raw].map((e) => (e as never as { cascadeExits: { label: string }[] }).cascadeExits[0]!.label);
    expect(labels[0]).toContain('XHTTP');
    expect(labels[1]).toContain('TCP');
    expect(labels[0]).not.toBe(labels[1]);
  });
});
