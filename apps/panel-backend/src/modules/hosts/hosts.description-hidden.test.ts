import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parse as parseYaml } from 'yaml';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { invalidateSrrCache } from '../srr/srr.service.js';
import { invalidateTemplateCache } from '../subscription-templates/templates.service.js';
import { registerBindingsCacheBust } from '../subscription/subscription.bindings-cache.js';
import { linkWithDescription } from '../subscription/subscription.description.js';

/**
 * A-236 step 6: a host's description, handed only to the apps that show one,
 * and a host the operator hid, in no public output unless a template asks.
 */

let app: FastifyInstance;
let token: string;

// A host edit mid-test must reach the next /sub read; the bus is wired in
// index.ts, not buildApp. Subscribed once: it has no unsubscribe.
beforeAll(() => registerBindingsCacheBust());

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  invalidateSrrCache();
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

/** A text that breaks hand-made YAML or JSON: quotes, a colon, a hash. */
const TRICKY = `Frankfurt: "fast" #1, it's 'ok'`;

/** One node, one vless binding with its auto-created host (address dh.test), one user. */
async function subscriber(): Promise<{ sub: string; bindingId: string; hostId: string }> {
  const node = await app.inject({ method: 'POST', url: '/api/nodes', headers: auth(), payload: { name: 'dh-node', address: 'dh.test', protocol: 'xray' } });
  const profile = await app.inject({
    method: 'POST', url: '/api/profiles', headers: auth(),
    payload: {
      name: 'dh-profile', protocol: 'xray',
      config: {
        security: 'reality', subprotocol: 'vless', network: 'raw',
        realityDest: 'www.microsoft.com:443', realityServerNames: ['www.microsoft.com'],
        realityPrivateKey: 'k'.repeat(43), realityPublicKey: 'p'.repeat(43), realityShortIds: ['0123abcd'],
      },
    },
  });
  const binding = await app.inject({
    method: 'POST', url: '/api/bindings', headers: auth(),
    payload: { profileId: JSON.parse(profile.body).id, nodeId: JSON.parse(node.body).id, port: 443 },
  });
  expect(binding.statusCode, binding.body).toBe(201);
  const user = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'dh-user' } });
  const sub = (await prisma.user.findUniqueOrThrow({ where: { id: JSON.parse(user.body).id as string }, select: { subscriptionToken: true } }))
    .subscriptionToken;
  const host = await prisma.host.findFirstOrThrow({ select: { id: true, bindingId: true } });
  return { sub, bindingId: host.bindingId, hostId: host.id };
}

const put = (hostId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/hosts/${hostId}`, headers: auth(), payload });

async function get(sub: string, query: string, ua?: string, accept?: string): Promise<string> {
  const headers: Record<string, string> = {};
  if (ua) headers['user-agent'] = ua;
  if (accept) headers.accept = accept;
  const res = await app.inject({ method: 'GET', url: `/sub/${sub}${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return query.includes('format=plain') ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
}

describe('the host API', () => {
  it('writes, reads and clears both fields; a PUT without them changes nothing', async () => {
    const { hostId } = await subscriber();
    const listed = async () =>
      (JSON.parse((await app.inject({ method: 'GET', url: '/api/hosts', headers: auth() })).body) as {
        hosts: { id: string; serverDescription: string | null; isHidden: boolean }[];
      }).hosts.find((h) => h.id === hostId)!;
    expect(await listed()).toMatchObject({ serverDescription: null, isHidden: false });

    const set = await put(hostId, { serverDescription: '  Fast lane  ', isHidden: true });
    expect(set.statusCode, set.body).toBe(200);
    expect(JSON.parse(set.body)).toMatchObject({ serverDescription: '  Fast lane  ', isHidden: true });
    expect(await listed()).toMatchObject({ serverDescription: '  Fast lane  ', isHidden: true });

    expect((await put(hostId, { remark: 'Renamed' })).statusCode).toBe(200);
    expect(await listed()).toMatchObject({ serverDescription: '  Fast lane  ', isHidden: true });

    expect((await put(hostId, { serverDescription: null, isHidden: false })).statusCode).toBe(200);
    expect(await listed()).toMatchObject({ serverDescription: null, isHidden: false });
  });

  it('refuses an empty, a multi-line and a too long description in words', async () => {
    const { hostId } = await subscriber();
    const cases: [unknown, string][] = [
      ['', 'serverDescription is empty: send null to clear it'],
      ['   ', 'serverDescription is empty: send null to clear it'],
      ['one\ntwo', 'serverDescription is one line: a line break or a control character is not allowed'],
      ['one\u2028two', 'serverDescription is one line: a line break or a control character is not allowed'],
      ['x'.repeat(201), 'serverDescription is at most 200 characters'],
    ];
    for (const [value, words] of cases) {
      const res = await put(hostId, { serverDescription: value });
      expect(res.statusCode, JSON.stringify(value)).toBe(400);
      const body = JSON.parse(res.body) as { error: string; issues: { path: string[]; message: string }[] };
      expect(body.error).toBe('VALIDATION_ERROR');
      expect(body.issues[0]).toMatchObject({ path: ['serverDescription'], message: words });
    }
    // 200 emoji are 200 characters.
    expect((await put(hostId, { serverDescription: '😀'.repeat(200) })).statusCode).toBe(200);
  });
});

describe('a hidden host', () => {
  async function withHidden() {
    const s = await subscriber();
    const hidden = await app.inject({
      method: 'POST', url: '/api/hosts', headers: auth(),
      payload: { bindingId: s.bindingId, remark: 'Hidden', addressOverride: 'hidden.test', isHidden: true },
    });
    expect(hidden.statusCode, hidden.body).toBe(201);
    return { ...s, hiddenId: JSON.parse(hidden.body).id as string };
  }

  it('is in no subscription format and on no page, but in the host list with isHidden', async () => {
    const { sub, hiddenId } = await withHidden();
    for (const q of ['?format=plain', '?format=raw', '?format=mihomo', '?format=stash', '?format=singbox', '?format=xrayjson', '?format=xrayjson-array', '?format=json']) {
      const body = await get(sub, q);
      expect(body, q).toContain('dh.test');
      expect(body, q).not.toContain('hidden.test');
    }
    const page = await get(sub, '', undefined, 'text/html');
    expect(page).not.toContain('hidden.test');
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/api/hosts', headers: auth() })).body) as { hosts: { id: string; isHidden: boolean }[] };
    expect(list.hosts.find((h) => h.id === hiddenId)?.isHidden).toBe(true);
  });

  it('a subscription of only hidden hosts offers no download on its page', async () => {
    const { sub, hostId } = await withHidden();
    expect((await get(sub, '', undefined, 'text/html'))).toContain('format=clash&amp;dl=1');
    expect((await put(hostId, { isHidden: true })).statusCode).toBe(200);
    expect((await get(sub, '', undefined, 'text/html'))).not.toContain('format=clash&amp;dl=1');
  });

  it('goes into a template that asks for hidden hosts, in that format only', async () => {
    const { sub } = await withHidden();
    const tpl = await app.inject({
      method: 'POST', url: '/api/subscription-templates', headers: auth(),
      payload: {
        type: 'mihomo', name: 'with-hidden',
        body: 'iceslab:\n  includeHiddenHosts: true\nproxies:\nproxy-groups:\n  - name: S\n    type: select\nrules:\n  - MATCH,S\n',
      },
    });
    expect(tpl.statusCode, tpl.body).toBe(201);
    const framed = await get(sub, '?format=mihomo&template=with-hidden');
    expect(framed).toContain('hidden.test');
    expect(framed).toContain('dh.test');
    // The service key never reaches the client.
    expect(framed).not.toContain('includeHiddenHosts');
    expect(await get(sub, '?format=mihomo')).not.toContain('hidden.test');
    expect(await get(sub, '?format=singbox')).not.toContain('hidden.test');
  });

  it('the key is true or false, refused on write with its line', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/subscription-templates', headers: auth(),
      payload: { type: 'mihomo', name: 'bad', body: 'iceslab:\n  includeHiddenHosts: "yes"\nproxies:\n' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'TEMPLATE_INVALID', line: 2 });
  });
});

describe('a host description', () => {
  async function described() {
    const s = await subscriber();
    expect((await put(s.hostId, { serverDescription: TRICKY })).statusCode).toBe(200);
    return s;
  }

  it('reaches a Clash app that shows it as a YAML value, the quotes and the colon intact and the neighbours unbroken', async () => {
    const { sub } = await described();
    const yaml = await get(sub, '?format=mihomo', 'FlClash X/0.3.0');
    const doc = parseYaml(yaml) as { proxies: Record<string, unknown>[] };
    expect(doc.proxies).toHaveLength(1);
    expect(doc.proxies[0]).toMatchObject({ type: 'vless', server: 'dh.test', port: 443, serverDescription: TRICKY });
    // Another Clash app gets the proxy without it.
    const plain = parseYaml(await get(sub, '?format=mihomo', 'clash-verge/v2.0.0')) as { proxies: Record<string, unknown>[] };
    expect(plain.proxies[0]!.serverDescription).toBeUndefined();
  });

  it('reaches Happ in the link as base64 after the title, and in xray-json-array as meta text', async () => {
    const { sub } = await described();
    const link = (await get(sub, '?format=plain', 'Happ/3.2.1')).split('\n').find((l) => l.startsWith('vless://'))!;
    const b64 = Buffer.from(TRICKY, 'utf-8').toString('base64');
    expect(link).toMatch(/#[^?]+\?serverDescription=/);
    expect(link.endsWith(`?serverDescription=${b64}`)).toBe(true);
    expect(await get(sub, '?format=plain', 'v2rayNG/1.9.0')).not.toContain('serverDescription');

    const configs = JSON.parse(await get(sub, '?format=xrayjson-array', 'Happ/3.2.1')) as { remarks: string; meta?: { serverDescription?: string } }[];
    expect(configs[0]!.meta).toEqual({ serverDescription: TRICKY });
    const other = JSON.parse(await get(sub, '?format=xrayjson-array', 'v2rayNG/1.9.0')) as { meta?: unknown }[];
    expect(other[0]!.meta).toBeUndefined();
  });

  it('is not in the json answer of a client that shows none', async () => {
    const { sub } = await described();
    expect(await get(sub, '?format=json', 'curl/8.0')).not.toContain('serverDescription');
    const mine = JSON.parse(await get(sub, '?format=json', 'Happ/3.2.1')) as { endpoints: { serverDescription?: string }[] };
    expect(mine.endpoints[0]!.serverDescription).toBe(TRICKY);
  });

  it('a vmess link carries it as a field of its JSON, as text', () => {
    const vmess = `vmess://${Buffer.from(JSON.stringify({ v: '2', ps: 'n', add: 'a.test' }), 'utf-8').toString('base64')}`;
    const out = linkWithDescription(vmess, TRICKY);
    const obj = JSON.parse(Buffer.from(out.slice('vmess://'.length), 'base64').toString('utf-8')) as Record<string, string>;
    expect(obj).toEqual({ v: '2', ps: 'n', add: 'a.test', serverDescription: TRICKY });
    // A scheme Happ does not list, or a link without a title, is left as it is.
    expect(linkWithDescription('hy2://p@h:443?sni=x#t', 'd')).toBe('hy2://p@h:443?sni=x#t');
    expect(linkWithDescription('vless://u@h:443?x=1', 'd')).toBe('vless://u@h:443?x=1');
  });
});
