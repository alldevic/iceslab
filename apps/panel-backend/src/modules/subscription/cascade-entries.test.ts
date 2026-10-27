import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { formatCarries } from '@iceslab/shared';
import { expandCascadeEntry } from './cascade-entries.js';
import { endpointsForFormat, type SubscriptionEndpoint } from './subscription.formats.js';
import { buildClashYaml } from './formats/clash.js';
import { buildSingboxJson } from './formats/singbox.js';
import { buildLoonConf } from './formats/loon.js';
import { buildQuantumultXConf } from './formats/quantumultx.js';
import { buildSurgeConf } from './formats/surge.js';
import { buildXrayJsonArray } from './formats/xrayjson.js';
import { expandEndpointUris } from './subscription.service.js';

/**
 * A-262: the routes of a balancer-cascade entry in every format that carries
 * VLESS. One expansion (expandCascadeEntry, run once in generateSubscription
 * before any format); here the formats are handed what it gives, as there.
 */

const UUID = '11111111-1111-4111-8111-111111111111';
// The dry run's key-shaped REALITY key (gitleaks allows it by value), so sing-box check loads the node.
const KEY = 'aWNlc2xhYi1kcnlydW4tcmVhbGl0eS1maXh0dXJlLTA';
const LABELS = ['stand-cascade → SE', 'stand-cascade → DE'];
const entry = {
  nodeId: 'n', port: 443, protocol: 'xray', nodeName: 'ge-01', host: 'ge.example.com',
  uri: `vless://${UUID}@ge.example.com:443?security=reality&pbk=${KEY}&sid=ab&sni=www.example.com&fp=chrome&type=tcp&flow=xtls-rprx-vision#ge-01`,
  uuid: UUID, publicKey: KEY, shortId: 'ab', sni: 'www.example.com', flow: 'xtls-rprx-vision',
  fingerprint: 'chrome', network: 'raw', subprotocol: 'vless', securityLayer: 'default', key: 'host-ge',
  cascadeExits: [
    { label: LABELS[0], tag: 1, cascadeId: 'c' },
    { label: LABELS[1], tag: 2, cascadeId: 'c' },
  ],
} as unknown as SubscriptionEndpoint;
const plain = { ...entry, nodeName: 'nl-01', host: 'nl.example.com', uuid: UUID, uri: entry.uri.replace('ge.example.com', 'nl.example.com'), key: 'host-nl', cascadeExits: undefined } as unknown as SubscriptionEndpoint;

const expanded = [entry, plain].flatMap(expandCascadeEntry);
/** The third UUID group carries the route tag (vlessRoute, bytes 7-8). */
const tagOf = (uuid: string) => parseInt(uuid.split('-')[2]!, 16);

describe('expandCascadeEntry', () => {
  it('an entry with two routes is two endpoints, tagged and named, and no bare entry; the rest as it was', () => {
    expect(expanded).toHaveLength(3);
    const routes = expanded.filter((e) => e.routeLabel);
    expect(routes.map((e) => e.routeLabel)).toEqual(LABELS);
    expect(routes.map((e) => tagOf((e as { uuid: string }).uuid))).toEqual([1, 2]);
    expect(routes.every((e) => e.cascadeExits === undefined)).toBe(true);
    expect(new Set(routes.map((e) => e.key)).size).toBe(2);
    expect(expanded.find((e) => e.nodeName === 'ge-01')).toBeUndefined();
    expect(expanded.find((e) => e.nodeName === 'nl-01')).toBe(plain);
  });

  it('trojan and vmess are not routed: vlessRoute is a VLESS field, the entry would refuse the changed credential', () => {
    for (const subprotocol of ['trojan', 'vmess']) {
      const e = { ...entry, subprotocol } as unknown as SubscriptionEndpoint;
      expect(expandCascadeEntry(e)).toEqual([e]);
    }
  });

  it('the links: one per route, the UUID tagged, the label as the name; already expanded, no second time', () => {
    const links = expanded.flatMap(expandEndpointUris);
    expect(links).toHaveLength(3);
    expect(links[0]).toContain(`${UUID.replace('4111', '0001')}@`);
    expect(links[0]!.endsWith(`#${encodeURIComponent(LABELS[0]!)}`)).toBe(true);
    expect(links[1]).toContain(`${UUID.replace('4111', '0002')}@`);
  });
});

describe('every format that carries VLESS hands out the routes', () => {
  for (const dialect of ['mihomo', 'stash', 'clash-legacy'] as const) {
    it(`${dialect}: two proxies with their tags, named by the routes, in the template's groups`, () => {
      const eps = endpointsForFormat(dialect === 'mihomo' ? 'mihomo' : dialect, expanded);
      const doc = parseYaml(buildClashYaml(eps, { dialect })) as { proxies: { name: string; uuid?: string }[]; 'proxy-groups': { name: string; proxies?: string[] }[] };
      if (dialect === 'clash-legacy') {
        // The legacy core has no vless (FORMAT_DOORS): neither the routes nor the entry.
        expect(doc.proxies.find((p) => LABELS.includes(p.name))).toBeUndefined();
        expect(formatCarries('clash-legacy', 'vless').carried).toBe(false);
        return;
      }
      const routes = doc.proxies.filter((p) => LABELS.includes(p.name));
      expect(routes.map((p) => tagOf(p.uuid!))).toEqual([1, 2]);
      expect(doc.proxies.find((p) => p.name.startsWith('ge-01'))).toBeUndefined();
      for (const g of doc['proxy-groups'].filter((x) => x.proxies && x.proxies.length > 0 && !x.proxies.includes('DIRECT'))) {
        expect(g.proxies, g.name).toEqual(expect.arrayContaining(LABELS));
      }
    });
  }

  it('singbox: two outbounds with their tags, in the selector and urltest, and sing-box check takes it', () => {
    const json = buildSingboxJson(endpointsForFormat('singbox', expanded));
    const cfg = JSON.parse(json) as { outbounds: { type: string; tag: string; uuid?: string; outbounds?: string[] }[] };
    const routes = cfg.outbounds.filter((o) => LABELS.includes(o.tag));
    expect(routes.map((o) => tagOf(o.uuid!))).toEqual([1, 2]);
    expect(cfg.outbounds.find((o) => o.tag.startsWith('ge-01'))).toBeUndefined();
    const groups = cfg.outbounds.filter((o) => o.type === 'selector' || o.type === 'urltest');
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) expect(g.outbounds, g.tag).toEqual(expect.arrayContaining(LABELS));
    const bin = process.env.SINGBOX_BIN;
    if (!bin) return;
    const dir = mkdtempSync(join(tmpdir(), 'a262-'));
    try {
      writeFileSync(join(dir, 'c.json'), json);
      try { execFileSync(bin, ['check', '-c', join(dir, 'c.json')], { stdio: 'pipe' }); } catch (e) { throw new Error(String((e as { stderr?: Buffer }).stderr ?? e)); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loon and quantumultx: a line per route with its tag, named by the route', () => {
    for (const [fmt, out] of [
      ['loon', buildLoonConf(endpointsForFormat('loon', expanded))],
      ['quantumultx', buildQuantumultXConf(endpointsForFormat('quantumultx', expanded))],
    ] as const) {
      const lines = out.split('\n');
      for (const [i, label] of LABELS.entries()) {
        const line = lines.find((l) => l.includes(label));
        expect(line, `${fmt} ${label}`).toBeDefined();
        expect(line, fmt).toContain(UUID.replace('4111', `000${i + 1}`));
      }
      expect(out, fmt).not.toMatch(/ge-01/);
    }
  });

  it('surge carries no vless, so no route and no entry, and the shared table says why', () => {
    const out = buildSurgeConf(endpointsForFormat('surge', expanded));
    for (const label of LABELS) expect(out).not.toContain(label);
    expect(out).not.toContain('ge-01');
    expect(formatCarries('surge', 'vless')).toMatchObject({ carried: false, why: 'client-lacks-protocol' });
  });

  it('the xray-json array: one config per route, the remark the label, the uuid tagged', () => {
    const configs = JSON.parse(buildXrayJsonArray(expanded)) as { remarks: string; outbounds: { settings?: { vnext?: { users: { id: string }[] }[] } }[] }[];
    const routes = configs.filter((c) => LABELS.includes(c.remarks));
    expect(routes.map((c) => tagOf(c.outbounds[0]!.settings!.vnext![0]!.users[0]!.id))).toEqual([1, 2]);
    expect(configs.find((c) => c.remarks === 'ge-01')).toBeUndefined();
  });
});
