import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { TEMPLATE_TYPES, type TemplateType } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis, redis } from '../../lib/infra/redis.js';
import { config } from '../../config.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { DEFAULT_TEMPLATE_BODIES, DEFAULT_TEMPLATE_IDS } from './templates.defaults.js';
import { checkTemplateBody, TemplateInvalidError } from './templates.parse.js';
import { invalidateTemplateCache } from './templates.service.js';

/**
 * A-236 step 2: subscription templates by the API contract 4.5a, the Default
 * of each type in the code, the service key checked on write.
 */

const refusalOf = (type: TemplateType, body: string): TemplateInvalidError | null => {
  try {
    checkTemplateBody(type, body);
    return null;
  } catch (err) {
    if (err instanceof TemplateInvalidError) return err;
    throw err;
  }
};

describe('checking a body', () => {
  it('takes every built-in Default', () => {
    for (const type of TEMPLATE_TYPES) expect(refusalOf(type, DEFAULT_TEMPLATE_BODIES[type]), type).toBeNull();
  });

  it('says the line of a YAML or JSON that does not parse', () => {
    const yaml = refusalOf('mihomo', 'proxies:\nproxy-groups:\n  - name: A\n   type: select\n');
    expect(yaml?.line).toBe(4);
    const json = refusalOf('singbox', '{\n  "log": {},\n  "outbounds": [\n}\n');
    expect(json?.line).toBe(4);
    expect(json?.message).toContain('not valid JSON');
  });

  it('refuses an unknown key inside iceslab, and a routing that is not "preset", with the line', () => {
    const key = refusalOf('mihomo', 'iceslab:\n  routing: preset\n  dns: mine\nproxies:\n');
    expect(key?.message).toContain('iceslab.dns is not a key the panel reads');
    expect(key?.line).toBe(3);
    const preset = refusalOf('singbox', '{\n  "iceslab": { "routing": "ru-split" }\n}\n');
    expect(preset?.message).toContain('"preset"');
    expect(preset?.line).toBe(2);
  });

  it('reads the group and provider keys of the Clash family, booleans only', () => {
    const ok = 'proxy-groups:\n  - name: A\n    type: select\n    iceslab:\n      include-proxies: false\n' +
      'proxy-providers:\n  mine:\n    type: inline\n    iceslab:\n      include-proxies: true\n';
    expect(refusalOf('stash', ok)).toBeNull();
    const bad = refusalOf('clash', 'proxy-groups:\n  - name: A\n    iceslab:\n      shuffle-proxies-order: yes please\n');
    expect(bad?.message).toContain('true or false');
    const unknown = refusalOf('clash', 'proxy-providers:\n  p:\n    iceslab:\n      shuffle-proxies-order: true\n');
    expect(unknown?.message).toContain('not a key the panel reads');
  });

  it('wants one object at the top: an array is not an xray-json-array frame', () => {
    expect(refusalOf('xray-json-array', '[{}]')?.message).toContain('one config object');
    expect(refusalOf('mihomo', '- a\n- b\n')?.message).toContain('config object');
    expect(refusalOf('singbox', '   ')?.message).toContain('empty');
  });
});

describe('/api/subscription-templates', () => {
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
  type Dto = { id: string; type: string; name: string; body: string; isDefault: boolean; updatedAt: string };
  const list = async () =>
    (JSON.parse((await app.inject({ method: 'GET', url: '/api/subscription-templates', headers: auth() })).body) as {
      templates: Dto[];
    }).templates;

  it('lists the code Default of every type with its fixed id, before any row exists', async () => {
    const all = await list();
    expect(all.map((t) => t.type)).toEqual([...TEMPLATE_TYPES]);
    for (const t of all) {
      expect(t).toMatchObject({ name: 'Default', isDefault: true, id: DEFAULT_TEMPLATE_IDS[t.type as TemplateType] });
      expect(t.body).toBe(DEFAULT_TEMPLATE_BODIES[t.type as TemplateType]);
    }
    expect(await prisma.subscriptionTemplate.count()).toBe(0);
  });

  it('creates an own template, refuses its name twice in a type, takes it in another', async () => {
    const make = (type: string, name: string, body = 'proxies:\n') =>
      app.inject({ method: 'POST', url: '/api/subscription-templates', headers: auth(), payload: { type, name, body } });
    const made = await make('mihomo', 'ru-strict');
    expect(made.statusCode, made.body).toBe(201);
    expect(JSON.parse(made.body)).toMatchObject({ type: 'mihomo', name: 'ru-strict', isDefault: false });
    const again = await make('mihomo', 'ru-strict');
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.body)).toMatchObject({ error: 'TEMPLATE_NAME_TAKEN', field: 'name' });
    expect((await make('stash', 'ru-strict')).statusCode).toBe(201);
    expect((await list()).filter((t) => t.name === 'ru-strict')).toHaveLength(2);
  });

  it('keeps the name Default for the built-in one, in any case and with blanks', async () => {
    for (const name of ['Default', 'default', '  DEFAULT  ']) {
      const res = await app.inject({
        method: 'POST', url: '/api/subscription-templates', headers: auth(),
        payload: { type: 'singbox', name, body: '{}' },
      });
      expect(res.statusCode, name).toBe(409);
      expect(JSON.parse(res.body).message).toContain('built-in template');
    }
    const own = await app.inject({
      method: 'POST', url: '/api/subscription-templates', headers: auth(),
      payload: { type: 'singbox', name: 'mine', body: '{}' },
    });
    const renamed = await app.inject({
      method: 'PUT', url: `/api/subscription-templates/${JSON.parse(own.body).id}`, headers: auth(),
      payload: { name: 'default' },
    });
    expect(renamed.statusCode).toBe(409);
    expect((await list()).filter((t) => t.type === 'singbox' && t.isDefault)).toHaveLength(1);
  });

  it('refuses an invalid body with its line, on create and on edit', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/subscription-templates', headers: auth(),
      payload: { type: 'mihomo', name: 'broken', body: 'iceslab:\n  routing: preset\n  extra: 1\n' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'TEMPLATE_INVALID', line: 3 });
    const edit = await app.inject({
      method: 'PUT', url: `/api/subscription-templates/${DEFAULT_TEMPLATE_IDS.singbox}`, headers: auth(),
      payload: { body: '{ "log": ' },
    });
    expect(edit.statusCode).toBe(400);
    expect(JSON.parse(edit.body).error).toBe('TEMPLATE_INVALID');
  });

  it('a Default is edited into a row, keeps its name, is not deleted, and is restored to the code', async () => {
    const id = DEFAULT_TEMPLATE_IDS.mihomo;
    const body = 'proxies:\nproxy-groups:\n  - name: Mine\n    type: select\nrules:\n  - MATCH,Mine\n';
    const edited = await app.inject({ method: 'PUT', url: `/api/subscription-templates/${id}`, headers: auth(), payload: { body } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(JSON.parse(edited.body)).toMatchObject({ id, name: 'Default', isDefault: true, body });
    expect((await list()).find((t) => t.id === id)!.body).toBe(body);

    const rename = await app.inject({ method: 'PUT', url: `/api/subscription-templates/${id}`, headers: auth(), payload: { name: 'Other' } });
    expect(rename.statusCode).toBe(409);
    expect(JSON.parse(rename.body).error).toBe('TEMPLATE_DEFAULT_PROTECTED');
    const del = await app.inject({ method: 'DELETE', url: `/api/subscription-templates/${id}`, headers: auth() });
    expect(del.statusCode).toBe(409);
    expect(JSON.parse(del.body).error).toBe('TEMPLATE_DEFAULT_PROTECTED');

    const restored = await app.inject({ method: 'POST', url: `/api/subscription-templates/${id}/restore-default`, headers: auth() });
    expect(restored.statusCode).toBe(200);
    expect(JSON.parse(restored.body).body).toBe(DEFAULT_TEMPLATE_BODIES.mihomo);
    expect(await prisma.subscriptionTemplate.count()).toBe(0);
    expect((await list()).find((t) => t.id === id)!.body).toBe(DEFAULT_TEMPLATE_BODIES.mihomo);
  });

  it('deletes an own template; restore-default on it is refused in words', async () => {
    const made = JSON.parse((await app.inject({
      method: 'POST', url: '/api/subscription-templates', headers: auth(),
      payload: { type: 'xray-json', name: 'mine', body: '{ "outbounds": [] }' },
    })).body) as Dto;
    const restore = await app.inject({ method: 'POST', url: `/api/subscription-templates/${made.id}/restore-default`, headers: auth() });
    expect(restore.statusCode).toBe(409);
    expect(JSON.parse(restore.body).error).toBe('TEMPLATE_NOT_DEFAULT');
    expect((await app.inject({ method: 'DELETE', url: `/api/subscription-templates/${made.id}`, headers: auth() })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/subscription-templates/${made.id}`, headers: auth() })).statusCode).toBe(404);
  });

  it('A-243: a honey token with a made-up template still trips the trap, alert and ban', async () => {
    const honey = 'honey-token-a243-xxxxxxxx';
    config.HONEY_USER_TOKENS.push(honey);
    const ip = '8.8.4.4';
    await redis.del(`sec:blacklist:${ip}`);
    try {
      const res = await app.inject({
        method: 'GET', url: `/sub/${honey}?format=singbox&template=no-such-template`, remoteAddress: ip,
      });
      // The trap's answer: a plausible empty 200, not a 404 about the template.
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('');
      expect(await redis.get(`sec:blacklist:${ip}`)).toBe('1');
    } finally {
      config.HONEY_USER_TOKENS.splice(config.HONEY_USER_TOKENS.indexOf(honey), 1);
      await redis.del(`sec:blacklist:${ip}`);
    }
  });

  it('A-243: an unknown token answers the same with a template that exists and one that does not', async () => {
    await app.inject({
      method: 'POST', url: '/api/subscription-templates', headers: auth(),
      payload: { type: 'singbox', name: 'exists', body: '{}' },
    });
    const ask = (name: string) => app.inject({ method: 'GET', url: `/sub/not-a-real-token-123456?format=singbox&template=${name}` });
    const [known, unknown] = await Promise.all([ask('exists'), ask('does-not-exist')]);
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.body).toBe(unknown.body);
    expect(known.statusCode).toBe(404);
    expect(JSON.parse(known.body).error).not.toBe('TEMPLATE_NOT_FOUND');
  });

  it('?template= on /sub: a name the type has passes, an unknown one and a format without templates are refused', async () => {
    const user = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'tpl-user' } });
    const { subscriptionToken } = await prisma.user.findUniqueOrThrow({
      where: { id: JSON.parse(user.body).id as string }, select: { subscriptionToken: true },
    });
    await app.inject({
      method: 'POST', url: '/api/subscription-templates', headers: auth(),
      payload: { type: 'singbox', name: 'mine', body: '{}' },
    });
    const sub = (q: string) => app.inject({ method: 'GET', url: `/sub/${subscriptionToken}?${q}` });
    expect((await sub('format=singbox&template=Default')).statusCode).toBe(200);
    expect((await sub('format=singbox&template=mine')).statusCode).toBe(200);
    const missing = await sub('format=clash&template=mine');
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ error: 'TEMPLATE_NOT_FOUND' });
    const plain = await sub('format=plain&template=Default');
    expect(plain.statusCode).toBe(400);
    expect(JSON.parse(plain.body)).toMatchObject({ error: 'TEMPLATE_NOT_FOR_FORMAT' });
  });
});

// ------------------------------------------------------------ the cores

const XRAY_BIN = process.env.XRAY_BIN ?? ['/usr/local/bin/xray', '/usr/bin/xray'].find((p) => existsSync(p)) ?? '';
const SINGBOX_BIN = process.env.SINGBOX_BIN ?? ['/usr/local/bin/sing-box', '/usr/bin/sing-box'].find((p) => existsSync(p)) ?? '';

/** The frame as a core reads it: the service key gone. */
function withoutServiceKey(body: string): string {
  const cfg = JSON.parse(body) as Record<string, unknown>;
  delete cfg.iceslab;
  return JSON.stringify(cfg);
}

function run(bin: string, args: (file: string) => string[], config: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'iceslab-tpl-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, config);
  try {
    const out = execFileSync(bin, args(file), { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
}

describe.skipIf(!SINGBOX_BIN)('sing-box 1.13 takes the Default frame', () => {
  it('check passes with no warning (rule actions, no legacy fields)', () => {
    const r = run(SINGBOX_BIN, (f) => ['check', '-c', f], withoutServiceKey(DEFAULT_TEMPLATE_BODIES.singbox));
    expect(r.ok, r.out).toBe(true);
    expect(r.out).not.toMatch(/WARN|deprecated/i);
  });
});

describe.skipIf(!XRAY_BIN)('xray takes the Default frames', () => {
  it('xray -test passes on the xray-json and xray-json-array frames', () => {
    for (const type of ['xray-json', 'xray-json-array'] as const) {
      const r = run(XRAY_BIN, (f) => ['-test', '-c', f], withoutServiceKey(DEFAULT_TEMPLATE_BODIES[type]));
      expect(r.ok, `${type}: ${r.out}`).toBe(true);
    }
  });
});
