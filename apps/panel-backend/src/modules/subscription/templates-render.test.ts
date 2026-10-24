import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { FastifyInstance } from 'fastify';
import { TEMPLATE_TYPES } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import {
  DEFAULT_TEMPLATE_BODIES,
  DEFAULT_TEMPLATE_IDS,
  DEFAULT_TEMPLATES_REVISION,
} from '../subscription-templates/templates.defaults.js';
import { invalidateTemplateCache } from '../subscription-templates/templates.service.js';
import { DRY_RUN_NODES } from '../subscription-templates/templates.dryrun.js';
import { goldenCases } from './templates-golden.cases.js';
import { defaultFrame, readFrame } from './subscription.frames.js';
import { buildClashYaml } from './formats/clash.js';
import { buildSingboxJson } from './formats/singbox.js';
import { buildXrayJson, buildXrayJsonArray } from './formats/xrayjson.js';

/**
 * A-236 step 3: the builders fill a frame. With the Default the output is
 * byte for byte what they wrote before frames (golden taken before the move),
 * an operator's frame comes out as written with the nodes in its slots, and
 * the dry run shows both with the core's word on it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(here, 'formats', '__testdata__', 'templates-default.golden.json');

describe('the Default frames', () => {
  it('render byte for byte what the builders wrote before frames (golden, 120 cases)', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    const cases = goldenCases();
    expect(Object.keys(cases).sort()).toEqual(Object.keys(golden).sort());
    for (const [k, render] of Object.entries(cases)) expect(render(), k).toBe(golden[k]);
  });

  it('the Default passed as a frame is the same as no frame', () => {
    const eps = DRY_RUN_NODES;
    expect(buildClashYaml(eps, { frame: defaultFrame('mihomo') })).toBe(buildClashYaml(eps));
    expect(buildSingboxJson(eps, { frame: defaultFrame('singbox') })).toBe(buildSingboxJson(eps));
    expect(buildXrayJson(eps, { frame: defaultFrame('xray-json') })).toBe(buildXrayJson(eps));
    expect(buildXrayJsonArray(eps, { frame: defaultFrame('xray-json-array') })).toBe(buildXrayJsonArray(eps));
  });

  it('DEFAULT_TEMPLATES_REVISION moves with the bodies', () => {
    const h = createHash('sha256');
    for (const t of TEMPLATE_TYPES) h.update(`${t}\n${DEFAULT_TEMPLATE_BODIES[t]}\n`);
    // A body changed and this fails: change DEFAULT_TEMPLATES_REVISION in
    // templates.defaults.ts to today, then the two values here.
    expect(
      { sha256: h.digest('hex'), revision: DEFAULT_TEMPLATES_REVISION },
      'a Default body changed: change DEFAULT_TEMPLATES_REVISION, then this sha256 and revision',
    ).toEqual({
      sha256: '8f6230c9bca59f6407d724f7ba952fe83a12d8e3355064abbe338aca68f123b9',
      revision: '2026-10-23T00:00:00.000Z',
    });
  });
});

describe('an operator frame', () => {
  const eps = DRY_RUN_NODES;
  const names = ['dry-run-1-xray', 'dry-run-2-xray', 'dry-run-3-hysteria'];

  it('mihomo: own keys kept, groups filled as their iceslab says, an empty group dropped and its rule sent DIRECT', () => {
    const frame = readFrame('mihomo', [
      'mixed-port: 7890',
      'dns:',
      '  enable: true',
      'iceslab:',
      '  routing: preset',
      'proxies:',
      'proxy-groups:',
      '  - name: Pick',
      '    type: select',
      '    proxies: [DIRECT]',
      '  - name: Nobody',
      '    type: select',
      '    iceslab:',
      '      include-proxies: false',
      '  - name: Fast',
      '    type: url-test',
      '    url: http://cp.example.com/generate_204',
      '    interval: 600',
      'rules:',
      '  - DOMAIN-SUFFIX,local.example,Nobody',
      '  - MATCH,Pick',
      '',
    ].join('\n'));
    const out = buildClashYaml(eps, { frame, routingPreset: 'ru-split' });
    const doc = parseYaml(out) as {
      'mixed-port': number; dns: { enable: boolean; 'nameserver-policy'?: unknown };
      proxies: { name: string }[]; 'proxy-groups': { name: string; proxies: string[] }[]; rules: string[];
    };
    expect(doc['mixed-port']).toBe(7890);
    // The frame's own dns stands; the preset's is not added on top.
    expect(doc.dns).toEqual({ enable: true });
    expect(doc.proxies.map((p) => p.name)).toEqual(names);
    expect(doc['proxy-groups'].map((g) => g.name)).toEqual(['Pick', 'Fast']);
    expect(doc['proxy-groups'][0]!.proxies).toEqual(['DIRECT', ...names]);
    // The preset's lines come first and send proxy traffic to the first group
    // that holds a node; the frame's rule to the dropped group goes DIRECT.
    expect(doc.rules[0]).toBe('GEOSITE,category-ads-all,REJECT');
    expect(doc.rules).toContain('DOMAIN-SUFFIX,local.example,DIRECT');
    expect(doc.rules[doc.rules.length - 1]).toBe('MATCH,Pick');
    expect(out).not.toContain('iceslab');
  });

  it('mihomo: a frame without iceslab gets no panel routing, and a provider takes the nodes as payload', () => {
    const frame = readFrame('mihomo', [
      'proxy-providers:',
      '  ours:',
      '    type: inline',
      '    iceslab:',
      '      include-proxies: true',
      'proxy-groups:',
      '  - name: All',
      '    type: select',
      '    use: [ours]',
      '    iceslab:',
      '      include-proxies: false',
      'rules:',
      '  - MATCH,All',
      '',
    ].join('\n'));
    const doc = parseYaml(buildClashYaml(eps, { frame, routingPreset: 'ru-split' })) as {
      'proxy-providers': { ours: { payload: { name: string }[] } }; rules: string[]; dns?: unknown;
      'proxy-groups': { name: string; use: string[] }[]; proxies: unknown[];
    };
    expect(doc['proxy-providers'].ours.payload.map((p) => p.name)).toEqual(names);
    expect(doc['proxy-groups'][0]).toMatchObject({ name: 'All', use: ['ours'] });
    expect(doc.rules).toEqual(['MATCH,All']);
    expect(doc.dns).toBeUndefined();
    // No `proxies` key in the frame: the nodes still go out, at the end.
    expect(doc.proxies).toHaveLength(3);
  });

  it('sing-box: every group gets the node tags, the frame route rules follow the preset', () => {
    const frame = readFrame('singbox', JSON.stringify({
      iceslab: { routing: 'preset' },
      log: { level: 'warn' },
      outbounds: [
        { type: 'selector', tag: 'Choose', outbounds: ['Fast', 'direct'], default: 'Fast' },
        { type: 'urltest', tag: 'Fast', outbounds: [] },
        { type: 'direct', tag: 'direct' },
      ],
      route: { rules: [{ domain_suffix: ['local.example'], action: 'route', outbound: 'direct' }], final: 'Choose' },
    }));
    const cfg = JSON.parse(buildSingboxJson(eps, { frame, routingPreset: 'ru-split' })) as {
      log: unknown; outbounds: { tag: string; outbounds?: string[]; default?: string }[];
      route: { rules: { outbound?: string; action: string }[]; final: string; rule_set: unknown[] };
    };
    expect(cfg.log).toEqual({ level: 'warn' });
    expect(cfg.outbounds.slice(0, 3).map((o) => o.tag)).toEqual(['dry-run-1-xray', 'dry-run-2-xray', 'dry-run-3-hysteria']);
    const choose = cfg.outbounds.find((o) => o.tag === 'Choose')!;
    expect(choose.outbounds).toEqual([...cfg.outbounds.slice(0, 3).map((o) => o.tag), 'Fast', 'direct']);
    expect(choose.default).toBe('Fast');
    expect(cfg.route.rules[0]).toMatchObject({ action: 'reject' });
    expect(cfg.route.rules[cfg.route.rules.length - 1]).toMatchObject({ outbound: 'direct' });
    expect(cfg.route.final).toBe('Choose');
    expect(cfg.route.rule_set.length).toBeGreaterThan(0);
  });

  it('xray-json-array: each element is the frame with its own node first and its own rules before the catch-all', () => {
    const frame = readFrame('xray-json-array', JSON.stringify({
      log: { loglevel: 'error' },
      outbounds: [{ tag: 'direct', protocol: 'freedom' }],
      routing: { domainStrategy: 'AsIs', rules: [{ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' }] },
    }));
    const arr = JSON.parse(buildXrayJsonArray(eps, { frame, routingPreset: 'ru-split' })) as {
      remarks: string; outbounds: { tag: string }[]; routing: { rules: { outboundTag?: string; ip?: string[] }[] }; dns?: unknown;
    }[];
    expect(arr.map((c) => c.remarks)).toEqual(['dry-run-1', 'dry-run-2', 'dry-run-3']);
    for (const c of arr) {
      expect(c.outbounds[1]).toEqual({ tag: 'direct', protocol: 'freedom' });
      // No iceslab: no preset, no split DNS; the frame's rule, then the catch-all.
      expect(c.dns).toBeUndefined();
      expect(c.routing.rules).toHaveLength(2);
      expect(c.routing.rules[0]!.ip).toEqual(['geoip:private']);
      expect(c.routing.rules[1]!.outboundTag).toBe(c.outbounds[0]!.tag);
    }
  });
});

// ------------------------------------------------------------ the API

describe('the subscription and the dry run', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    await cleanDatabase();
    invalidateTemplateCache();
    token = await registerAndLogin(app);
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  async function subscriber(): Promise<string> {
    const node = await app.inject({ method: 'POST', url: '/api/nodes', headers: auth(), payload: { name: 'tr-node', address: 'tr.test', protocol: 'xray' } });
    const profile = await app.inject({
      method: 'POST', url: '/api/profiles', headers: auth(),
      payload: {
        name: 'tr-profile', protocol: 'xray',
        config: {
          security: 'reality', subprotocol: 'vless', network: 'raw',
          realityDest: 'www.microsoft.com:443', realityServerNames: ['www.microsoft.com'],
          realityPrivateKey: 'k'.repeat(43), realityPublicKey: 'p'.repeat(43), realityShortIds: ['0123abcd'],
        },
      },
    });
    expect(node.statusCode, node.body).toBe(201);
    expect(profile.statusCode, profile.body).toBe(201);
    const binding = await app.inject({
      method: 'POST', url: '/api/bindings', headers: auth(),
      payload: { profileId: JSON.parse(profile.body).id, nodeId: JSON.parse(node.body).id, port: 443 },
    });
    expect(binding.statusCode, binding.body).toBe(201);
    const user = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'tr-user' } });
    expect(user.statusCode, user.body).toBe(201);
    return (await prisma.user.findUniqueOrThrow({ where: { id: JSON.parse(user.body).id as string }, select: { subscriptionToken: true } }))
      .subscriptionToken;
  }

  it('?template= frames the file, and an edited Default frames it without asking', async () => {
    const sub = await subscriber();
    const before = (await app.inject({ method: 'GET', url: `/sub/${sub}?format=singbox` })).body;
    expect(JSON.parse(before).log).toEqual({ level: 'info', timestamp: true });

    await app.inject({
      method: 'POST', url: '/api/subscription-templates', headers: auth(),
      payload: { type: 'singbox', name: 'quiet', body: JSON.stringify({ log: { level: 'error' }, outbounds: [{ type: 'selector', tag: 'S', outbounds: [] }], route: { final: 'S' } }) },
    });
    const pickedRes = await app.inject({ method: 'GET', url: `/sub/${sub}?format=singbox&template=quiet` });
    const picked = JSON.parse(pickedRes.body);
    expect(picked.log, pickedRes.body).toEqual({ level: 'error' });
    expect(picked.outbounds.find((o: { tag: string }) => o.tag === 'S')?.outbounds, pickedRes.body).toHaveLength(1);

    await app.inject({
      method: 'PUT', url: `/api/subscription-templates/${DEFAULT_TEMPLATE_IDS.singbox}`, headers: auth(),
      payload: { body: JSON.stringify({ log: { level: 'debug' }, outbounds: [] }) },
    });
    const edited = JSON.parse((await app.inject({ method: 'GET', url: `/sub/${sub}?format=singbox` })).body);
    expect(edited.log).toEqual({ level: 'debug' });
    // Restored: the builders' own Default again, byte for byte.
    await app.inject({ method: 'POST', url: `/api/subscription-templates/${DEFAULT_TEMPLATE_IDS.singbox}/restore-default`, headers: auth() });
    expect((await app.inject({ method: 'GET', url: `/sub/${sub}?format=singbox` })).body).toBe(before);
  });

  it('dry-run: the Default is ok with the nodes in it; a frame without a slot is not, and says why', async () => {
    const run = (type: string, body: string) =>
      app.inject({ method: 'POST', url: '/api/subscription-templates/dry-run', headers: auth(), payload: { type, body } });
    type Answer = { ok: boolean | null; rendered: string; check: { ok: boolean | null; message?: string }; warnings: string[] };
    for (const type of TEMPLATE_TYPES) {
      const res = await run(type, DEFAULT_TEMPLATE_BODIES[type]);
      expect(res.statusCode, `${type}: ${res.body}`).toBe(200);
      const r = JSON.parse(res.body) as Answer;
      expect(r.rendered, type).toContain('node-1.example.com');
      expect(r.warnings, type).toEqual([]);
      const clashFamily = type === 'mihomo' || type === 'stash' || type === 'clash';
      const ran = clashFamily ? false : type === 'singbox' ? !!SINGBOX_BIN : !!XRAY_BIN;
      // null is not yes: with no core to ask, nothing says the file is good.
      expect(r.check.ok, `${type}: ${r.check.message}`).toBe(ran ? true : null);
      expect(r.ok, type).toBe(ran ? true : null);
    }

    // No binary on the panel (as in the image today): null, not true.
    const saved = { s: process.env.SINGBOX_BIN, x: process.env.XRAY_BIN };
    process.env.SINGBOX_BIN = '';
    process.env.XRAY_BIN = '';
    try {
      const sb = JSON.parse((await run('singbox', DEFAULT_TEMPLATE_BODIES.singbox)).body) as Answer;
      expect(sb.check).toEqual({ ok: null, message: 'not checked: no sing-box binary on the panel' });
      expect(sb.ok).toBeNull();
      const xa = JSON.parse((await run('xray-json-array', DEFAULT_TEMPLATE_BODIES['xray-json-array'])).body) as Answer;
      expect(xa.ok).toBeNull();
      // A warning with no core to ask is still a no.
      const unslotted = JSON.parse((await run('singbox', JSON.stringify({ outbounds: [{ type: 'direct', tag: 'direct' }] }))).body) as Answer;
      expect(unslotted.check.ok).toBeNull();
      expect(unslotted.ok).toBe(false);
    } finally {
      if (saved.s === undefined) delete process.env.SINGBOX_BIN;
      else process.env.SINGBOX_BIN = saved.s;
      if (saved.x === undefined) delete process.env.XRAY_BIN;
      else process.env.XRAY_BIN = saved.x;
    }
    const noGroup = JSON.parse((await run('mihomo', 'rules:\n  - MATCH,DIRECT\n')).body) as { ok: boolean; warnings: string[] };
    expect(noGroup.ok).toBe(false);
    expect(noGroup.warnings.join(' ')).toContain('no proxy group holds a node');
    const noSelector = JSON.parse((await run('singbox', JSON.stringify({ outbounds: [{ type: 'direct', tag: 'direct' }] }))).body) as {
      ok: boolean; warnings: string[];
    };
    expect(noSelector.ok).toBe(false);
    expect(noSelector.warnings.join(' ')).toContain('selector or urltest');
    const invalid = await run('singbox', '{ "log": ');
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body).error).toBe('TEMPLATE_INVALID');
  });
});

// ------------------------------------------------------------ the cores

const XRAY_BIN = process.env.XRAY_BIN ?? ['/usr/local/bin/xray', '/usr/bin/xray'].find((p) => existsSync(p)) ?? '';
const SINGBOX_BIN = process.env.SINGBOX_BIN ?? ['/usr/local/bin/sing-box', '/usr/bin/sing-box'].find((p) => existsSync(p)) ?? '';

function check(bin: string, args: (f: string) => string[], config: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'iceslab-render-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, config);
  try {
    return execFileSync(bin, args(file), { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
}

describe.skipIf(!SINGBOX_BIN)('sing-box 1.13 takes the rendered Default with nodes', () => {
  it('check passes with no warning', () => {
    const out = check(SINGBOX_BIN, (f) => ['check', '-c', f], buildSingboxJson(DRY_RUN_NODES));
    expect(out).not.toMatch(/WARN|deprecated/i);
  });
});

describe.skipIf(!XRAY_BIN)('xray takes the rendered Defaults with nodes', () => {
  it('xray -test passes on xray-json and every element of xray-json-array', () => {
    check(XRAY_BIN, (f) => ['-test', '-c', f], buildXrayJson(DRY_RUN_NODES));
    for (const c of JSON.parse(buildXrayJsonArray(DRY_RUN_NODES)) as unknown[]) {
      check(XRAY_BIN, (f) => ['-test', '-c', f], JSON.stringify(c));
    }
  });
});
