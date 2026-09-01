import { describe, expect, it } from 'vitest';
import { buildClashYaml } from './formats/clash.js';
import { buildSingboxJson } from './formats/singbox.js';
import { buildSurgeConf } from './formats/surge.js';
import { buildQuantumultXConf } from './formats/quantumultx.js';
import { buildLoonConf } from './formats/loon.js';
import { buildXrayJson, buildXrayJsonArray } from './formats/xrayjson.js';
import { expandEndpointUris } from './subscription.service.js';
import { SUBSCRIPTION_FORMATS } from './subscription.format-names.js';
import type { SubscriptionEndpoint } from './subscription.formats.js';

/**
 * MIRROR: every format that renders an xray server must expand a cascade entry
 * into one server PER EXIT, with the exit's tag in UUID bytes 7-8.
 *
 * Why a mirror test and not six ordinary ones. This has now been missed twice,
 * by different formats, and both times it was invisible: the subscription
 * serves 200, the client connects, authenticates as the right user, and
 * egresses at the ENTRY while the line it came from names the exit. For our
 * deployment that means a buyer who picked the Netherlands leaves from a
 * Russian address and neither side says anything. The v4 cascade entry has no
 * catch-all - an untagged UUID falls through to `freedom` - so "the format
 * forgot" and "the buyer's traffic left the wrong country" are the same event.
 *
 * The ratchet is the format LIST: every entry in SUBSCRIPTION_FORMATS has to be
 * classified here, either as one that expands (and is proved to) or as one that
 * renders no xray server (with the reason). Adding a format without touching
 * this file fails the last test in the file, which is the point - the next
 * format is the one that would otherwise repeat this.
 */

const ENTRY_NAME = 'ru-01';
const EXITS = [
  { label: 'NL-exit', tag: 1 },
  { label: 'DE-exit', tag: 2 },
];

const realityEntry: SubscriptionEndpoint = {
  protocol: 'xray',
  nodeName: ENTRY_NAME,
  host: 'ru01.example',
  port: 443,
  uuid: '11111111-2222-3333-4444-555555555555',
  publicKey: 'PUBKEY',
  shortId: 'SHORT',
  sni: 'www.cloudflare.com',
  flow: 'xtls-rprx-vision',
  fingerprint: 'chrome',
  network: 'raw',
  subprotocol: 'vless',
  securityLayer: 'default',
  uri: 'vless://11111111-2222-3333-4444-555555555555@ru01.example:443?type=raw#ru-01',
  cascadeExits: EXITS,
};

/** Surge declines REALITY outright (it has no vless/reality spelling), so the
 *  shape that proves anything about Surge is a trojan over real TLS. */
const trojanEntry: SubscriptionEndpoint = {
  ...realityEntry,
  subprotocol: 'trojan',
  securityLayer: 'tls',
  password: 'trojan-pass',
  uri: 'trojan://11111111-2222-3333-4444-555555555555@ru01.example:443#ru-01',
};

/** UUID bytes 7-8 as they appear once written: the 3rd hyphen-group. */
const TAGGED = ['-0001-', '-0002-'];

type Case = { format: string; render: (e: SubscriptionEndpoint) => string; fixture: SubscriptionEndpoint };

const EXPANDS: Case[] = [
  { format: 'clash', render: (e) => buildClashYaml([e]), fixture: realityEntry },
  { format: 'singbox', render: (e) => buildSingboxJson([e]), fixture: realityEntry },
  { format: 'xrayjson', render: (e) => buildXrayJson([e]), fixture: realityEntry },
  { format: 'xkeen', render: (e) => buildXrayJson([e], { forRouter: true }), fixture: realityEntry },
  { format: 'xrayjson-array', render: (e) => buildXrayJsonArray([e]), fixture: realityEntry },
  { format: 'plain', render: (e) => expandEndpointUris(e).join('\n'), fixture: realityEntry },
  { format: 'surge', render: (e) => buildSurgeConf([e]), fixture: trojanEntry },
  { format: 'quantumultx', render: (e) => buildQuantumultXConf([e]), fixture: realityEntry },
  { format: 'loon', render: (e) => buildLoonConf([e]), fixture: realityEntry },
];

/** Formats that render no xray server, with the reason each is exempt. */
const NO_XRAY_SERVER: Record<string, string> = {
  wgconf: 'wg-quick .conf: WireGuard/AmneziaWG only, no xray outbound exists',
  amneziavpn: 'AmneziaVPN key: the wg family again',
  outline: 'Outline: shadowsocks only',
  json: 'the structured Mini-App body hands the model through UNEXPANDED, cascadeExits included, and its consumer expands. It is the one format whose contract is the model rather than a client config; if a consumer ever reads `uri` off it instead, it belongs in EXPANDS.',
};

describe('every format that renders an xray server expands cascade exits', () => {
  for (const { format, render, fixture } of EXPANDS) {
    describe(format, () => {
      const out = render(fixture);

      it('renders something at all (a fixture the format skips proves nothing)', () => {
        expect(out.length).toBeGreaterThan(0);
      });

      it('names every exit', () => {
        for (const x of EXITS) expect(out).toContain(x.label);
      });

      it('does not offer the entry as its own line', () => {
        expect(out).not.toContain(ENTRY_NAME);
      });

      it('writes each exit tag into the UUID', () => {
        for (const t of TAGGED) expect(out).toContain(t);
        // The untagged UUID must be gone: leaving it is what egresses at the
        // entry, and it is the failure that reports nothing.
        expect(out).not.toContain(fixture.uuid);
      });
    });
  }

  it('classifies every format in SUBSCRIPTION_FORMATS', () => {
    const covered = new Set([...EXPANDS.map((c) => c.format), ...Object.keys(NO_XRAY_SERVER)]);
    // `xkeen` is a rendering mode of xrayjson rather than its own builder, but
    // it is its own `?format=`, so it is classified like any other.
    const unclassified = SUBSCRIPTION_FORMATS.filter((f) => !covered.has(f));
    expect(unclassified).toEqual([]);
    // And nothing claimed here may have fallen out of the registry.
    const stale = [...covered].filter((f) => !(SUBSCRIPTION_FORMATS as readonly string[]).includes(f));
    expect(stale).toEqual([]);
  });
});

describe('the URI travels with the UUID', () => {
  it('plain emits one link per exit, each tagged and labelled', () => {
    const lines = expandEndpointUris(realityEntry);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('-0001-');
    expect(lines[0]).toContain('#NL-exit');
    expect(lines[1]).toContain('-0002-');
    expect(lines[1]).toContain('#DE-exit');
    for (const l of lines) expect(l).not.toContain(realityEntry.uuid);
  });

  it('vmess yields its single untagged link - the URI is a base64 blob', () => {
    const vmess: SubscriptionEndpoint = { ...realityEntry, subprotocol: 'vmess' };
    expect(expandEndpointUris(vmess)).toEqual([vmess.uri]);
  });

  it('an endpoint with no exits comes back untouched', () => {
    const plain: SubscriptionEndpoint = { ...realityEntry, cascadeExits: undefined };
    expect(expandEndpointUris(plain)).toEqual([plain.uri]);
  });
});
