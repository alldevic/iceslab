import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parse as parseYaml } from 'yaml';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { invalidateSrrCache } from '../srr/srr.service.js';
import { invalidateTemplateCache } from '../subscription-templates/templates.service.js';
import { endpointsForFormat, type SubscriptionEndpoint } from './subscription.formats.js';
import { buildClashYaml } from './formats/clash.js';

/**
 * A-236 step 4: the Clash family by core. One builder, the fields Stash and
 * the legacy Clash core spell differently (stash.wiki/en/proxy-protocols/
 * proxy-types, clash.wiki/configuration/outbound.html, read 24.10); `clash`
 * stays the alias of mihomo byte for byte; an SRR rule names the template.
 */

const base = { nodeId: 'n', port: 443, uri: '' } as const;
const UUID = '11111111-1111-4111-8111-111111111111';
const eps = [
  { ...base, protocol: 'xray', nodeName: 'vr', host: 'vr.example.com', uuid: UUID, publicKey: 'PUB', shortId: 'ab',
    sni: 'www.example.com', flow: 'xtls-rprx-vision', fingerprint: 'chrome', network: 'raw', subprotocol: 'vless', securityLayer: 'default' },
  { ...base, protocol: 'xray', nodeName: 'vx', host: 'vx.example.com', uuid: UUID, publicKey: 'PUB', shortId: 'ab',
    sni: 'www.example.com', flow: '', fingerprint: 'chrome', network: 'xhttp', path: '/x', xhttpMode: 'stream-one', subprotocol: 'vless', securityLayer: 'default' },
  { ...base, protocol: 'xray', nodeName: 'vm', host: 'vm.example.com', uuid: UUID, publicKey: '', shortId: '',
    sni: 'vm.example.com', flow: '', fingerprint: 'chrome', network: 'ws', path: '/w', subprotocol: 'vmess', securityLayer: 'tls' },
  { ...base, protocol: 'xray', nodeName: 'tt', host: 'tt.example.com', uuid: UUID, publicKey: '', shortId: '',
    sni: 'tt.example.com', flow: '', fingerprint: 'chrome', network: 'ws', path: '/t', subprotocol: 'trojan', securityLayer: 'tls' },
  { ...base, protocol: 'xray', nodeName: 'tr', host: 'tr.example.com', uuid: UUID, publicKey: 'PUB', shortId: 'ab',
    sni: 'www.example.com', flow: '', fingerprint: 'chrome', network: 'raw', subprotocol: 'trojan', securityLayer: 'default' },
  { ...base, protocol: 'hysteria', nodeName: 'hy', host: '1.2.3.4', password: 'pw',
    tlsPin: { certSha256: 'aabbcc', certPem: 'x', serverName: '1.2.3.4' } },
  { ...base, protocol: 'tuic', nodeName: 'tu', host: 'tu.example.com', uuid: UUID, password: 'p', serverName: 'tu.example.com', congestionControl: 'bbr' },
  { ...base, protocol: 'mieru', nodeName: 'mi', host: 'mi.example.com', username: 'u', password: 'p', mtu: 1400 },
  { ...base, protocol: 'shadowsocks', nodeName: 's22', host: 's22.example.com', method: '2022-blake3-aes-128-gcm', password: 'p' },
  { ...base, protocol: 'shadowsocks', nodeName: 'sold', host: 'sold.example.com', method: 'aes-256-gcm', password: 'p' },
] as unknown as SubscriptionEndpoint[];

type Proxy = Record<string, unknown> & { name: string };
const proxiesOf = (yaml: string) => (parseYaml(yaml) as { proxies: Proxy[] }).proxies;
const byNode = (yaml: string) => Object.fromEntries(proxiesOf(yaml).map((p) => [p.name.split('-')[0]!, p]));

describe('the Stash dialect', () => {
  const out = buildClashYaml(endpointsForFormat('stash', eps), { dialect: 'stash' });
  const p = byNode(out);

  it('names the SNI `sni` on vless and trojan, `servername` on vmess', () => {
    expect(p.vr).toMatchObject({ type: 'vless', sni: 'www.example.com' });
    expect(p.vr!.servername).toBeUndefined();
    expect(p.tt).toMatchObject({ type: 'trojan', sni: 'tt.example.com' });
    expect(p.vm).toMatchObject({ type: 'vmess', servername: 'vm.example.com' });
  });

  it('carries XHTTP with its mode in xhttp-opts, as the Stash docs write it', () => {
    expect(p.vx).toMatchObject({ network: 'xhttp', 'xhttp-opts': { path: '/x', mode: 'stream-one' } });
  });

  it('hysteria2: auth for the password, the pin as server-cert-fingerprint', () => {
    expect(p.hy).toMatchObject({ type: 'hysteria2', auth: 'pw', 'server-cert-fingerprint': 'aabbcc' });
    expect(p.hy!.password).toBeUndefined();
    expect(p.hy!.fingerprint).toBeUndefined();
  });

  it('tuic says version 5 and no udp-relay-mode; mieru writes tcp in lower case', () => {
    expect(p.tu).toMatchObject({ type: 'tuic', version: 5 });
    expect(p.tu!['udp-relay-mode']).toBeUndefined();
    expect(p.mi).toMatchObject({ transport: 'tcp' });
  });
});

describe('the legacy Clash dialect', () => {
  const out = buildClashYaml(endpointsForFormat('clash-legacy', eps), { dialect: 'clash-legacy' });
  const p = byNode(out);

  it('has no vless, no REALITY, trojan over TLS only, nothing newer, no 2022 cipher', () => {
    expect(Object.keys(p).sort()).toEqual(['sold', 'tt', 'vm']);
  });

  it('names trojan SNI `sni` and writes no uTLS fingerprint', () => {
    expect(p.tt).toMatchObject({ type: 'trojan', sni: 'tt.example.com' });
    expect(p.tt!['client-fingerprint']).toBeUndefined();
    expect(p.vm!['client-fingerprint']).toBeUndefined();
  });
});

describe('mihomo and its alias', () => {
  it('clash is mihomo byte for byte', () => {
    expect(buildClashYaml(eps, { dialect: 'mihomo' })).toBe(buildClashYaml(eps));
  });
});

// ------------------------------------------------------------ through /sub

describe('SRR families and templates through /sub', () => {
  let app: FastifyInstance;
  let token: string;

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

  async function subscriber(): Promise<string> {
    const node = await app.inject({ method: 'POST', url: '/api/nodes', headers: auth(), payload: { name: 'cd-node', address: 'cd.test', protocol: 'xray' } });
    const profile = await app.inject({
      method: 'POST', url: '/api/profiles', headers: auth(),
      payload: {
        name: 'cd-profile', protocol: 'xray',
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
    const user = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'cd-user' } });
    return (await prisma.user.findUniqueOrThrow({ where: { id: JSON.parse(user.body).id as string }, select: { subscriptionToken: true } }))
      .subscriptionToken;
  }

  it('?format=clash answers exactly ?format=mihomo', async () => {
    const sub = await subscriber();
    const clash = await app.inject({ method: 'GET', url: `/sub/${sub}?format=clash` });
    const mihomo = await app.inject({ method: 'GET', url: `/sub/${sub}?format=mihomo` });
    expect(clash.statusCode).toBe(200);
    expect(clash.body).toBe(mihomo.body);
  });

  it('a rule names a template of its format\'s type; the matched client gets it, and the Default once it is gone', async () => {
    const sub = await subscriber();
    const bad = await app.inject({
      method: 'POST', url: '/api/srr', headers: auth(),
      payload: { name: 'Mine', uaPattern: 'MyStash', format: 'stash', templateName: 'nope', priority: 1 },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({ error: 'SRR_TEMPLATE_NOT_FOUND', field: 'templateName' });
    const noFrame = await app.inject({
      method: 'POST', url: '/api/srr', headers: auth(),
      payload: { name: 'Mine', uaPattern: 'MyStash', format: 'plain', templateName: 'Default', priority: 1 },
    });
    expect(JSON.parse(noFrame.body)).toMatchObject({ error: 'SRR_TEMPLATE_NOT_FOR_FORMAT' });

    const tpl = await app.inject({
      method: 'POST', url: '/api/subscription-templates', headers: auth(),
      payload: { type: 'stash', name: 'stash-own', body: 'mixed-port: 7777\nproxies:\nproxy-groups:\n  - name: S\n    type: select\nrules:\n  - MATCH,S\n' },
    });
    const tplId = JSON.parse(tpl.body).id as string;
    const rule = await app.inject({
      method: 'POST', url: '/api/srr', headers: auth(),
      payload: { name: 'Mine', uaPattern: 'MyStash', format: 'stash', templateName: 'stash-own', priority: 1 },
    });
    expect(rule.statusCode, rule.body).toBe(201);
    expect(JSON.parse(rule.body)).toMatchObject({ templateName: 'stash-own' });

    const framed = await app.inject({ method: 'GET', url: `/sub/${sub}`, headers: { 'user-agent': 'MyStash/1.0' } });
    expect(framed.statusCode).toBe(200);
    const doc = parseYaml(framed.body) as { 'mixed-port': number; 'proxy-groups': { name: string }[]; proxies: Proxy[] };
    expect(doc['mixed-port']).toBe(7777);
    expect(doc['proxy-groups'][0]!.name).toBe('S');
    expect(doc.proxies[0]).toMatchObject({ type: 'vless', sni: expect.any(String) });

    await app.inject({ method: 'DELETE', url: `/api/subscription-templates/${tplId}`, headers: auth() });
    const fallback = await app.inject({ method: 'GET', url: `/sub/${sub}`, headers: { 'user-agent': 'MyStash/1.0' } });
    expect(fallback.statusCode).toBe(200);
    expect((parseYaml(fallback.body) as { 'proxy-groups': { name: string }[] })['proxy-groups'][0]!.name).toBe('Auto');
  });
});
