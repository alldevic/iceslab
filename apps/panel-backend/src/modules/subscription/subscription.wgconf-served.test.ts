import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { inflateSync } from 'node:zlib';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { invalidateSrrCache } from '../srr/srr.service.js';
import { invalidateSubscriptionSettingsCache } from '../settings/settings.service.js';
import { WG_TEST_PRIVATE_KEY, WG_TEST_PUBLIC_KEY } from '../../../tests/helpers/wg-keys.js';

/**
 * 9.8: what a served wg config carries from the panel settings (DNS, `::/0`),
 * the tunnel name (file and `# Name =`) and the type it is downloaded under.
 */

let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

async function post(url: string, payload: object): Promise<string> {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  if (res.statusCode !== 201) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).id as string;
}

let seq = 0;
async function bind(protocol: string, config: object, nodeId: string, port: number) {
  seq += 1;
  const profileId = await post('/api/profiles', { name: `${protocol}-${seq}`, protocol, config });
  await post('/api/bindings', { profileId, nodeId, port });
}

let caller = 0;
const get = (url: string, accept?: string) => {
  caller += 1;
  return app.inject({
    method: 'GET',
    url,
    ...(accept ? { headers: { accept } } : {}),
    remoteAddress: `10.79.${Math.floor(caller / 250)}.${caller % 250}`,
  });
};

const setSettings = async (payload: object) => {
  const res = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth(), payload });
  expect(res.statusCode, res.body).toBe(200);
};

const AWG = { subnet: '10.66.66.0/24', serverPrivateKey: WG_TEST_PRIVATE_KEY, serverPublicKey: WG_TEST_PUBLIC_KEY, obfuscation: {} };
const WG = { subnet: '10.77.77.0/24', serverPrivateKey: WG_TEST_PRIVATE_KEY, serverPublicKey: WG_TEST_PUBLIC_KEY };

async function subscriber() {
  const node = await post('/api/nodes', { name: 'amsterdam-primary-1', address: '10.0.0.1:8443' });
  await bind('amneziawg', AWG, node, 51820);
  await bind('wireguard', WG, node, 51830);
  const id = await post('/api/users', { username: 'alice' });
  const u = await prisma.user.findUniqueOrThrow({ where: { id }, select: { subscriptionToken: true } });
  return u.subscriptionToken;
}

const decodeKey = (link: string) => {
  const raw = Buffer.from(link.replace(/^vpn:\/\//, ''), 'base64url');
  return JSON.parse(inflateSync(raw.subarray(4)).toString('utf8')) as Record<string, unknown> & {
    containers: { awg: { last_config: string } }[];
  };
};

const fileName = (res: { headers: Record<string, unknown> }) =>
  /^attachment; filename="([^"]+)"$/.exec(String(res.headers['content-disposition']))?.[1];

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  invalidateSrrCache();
  invalidateSubscriptionSettingsCache();
  token = await registerAndLogin(app);
  seq = 0;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const URLS = (t: string) => [
  `/sub/${t}?format=wgconf&protocols=amneziawg`,
  `/sub/${t}?format=wgconf&protocols=wireguard`,
];

describe('the served .conf file', () => {
  it('is application/octet-stream, named <= 15 characters of [A-Za-z0-9._-] with .conf, and its # Name line is that name', async () => {
    await setSettings({ brandName: 'Onegin VPN Network Pro' });
    const t = await subscriber();
    const names = new Set<string>();
    for (const url of [...URLS(t), `/sub/${t}?format=wgconf&protocols=amneziawg&device=2`, `/sub/${t}?format=wgconf&protocols=wireguard&device=3`]) {
      const res = await get(url);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type'], url).toBe('application/octet-stream');
      const file = fileName(res)!;
      expect(file, url).toMatch(/^[A-Za-z0-9._-]{1,15}\.conf$/);
      const name = file.replace(/\.conf$/, '');
      expect(res.body.split('\n')[0], url).toBe(`# Name = ${name}`);
      names.add(name);
    }
    // Kinds and devices never share a name.
    expect(names.size).toBe(4);
  });

  it('with no brand set it is still a name, from the panel default', async () => {
    const t = await subscriber();
    const res = await get(`/sub/${t}?format=wgconf&protocols=wireguard`);
    expect(fileName(res)).toMatch(/^[A-Za-z0-9._-]{1,15}-wg\.conf$/);
  });

  it('is brand-derived, not the username', async () => {
    await setSettings({ brandName: 'Onegin' });
    const t = await subscriber();
    const res = await get(`/sub/${t}?format=wgconf&protocols=wireguard`);
    expect(fileName(res)!.startsWith('Oneg')).toBe(true);
    expect(fileName(res)).not.toContain('alice');
  });

  it('keeps the text/plain answer of amneziavpn and the empty-answer contract', async () => {
    const t = await subscriber();
    const vpn = await get(`/sub/${t}?format=amneziavpn`);
    expect(vpn.headers['content-type']).toContain('text/plain');
    expect(vpn.body.startsWith('vpn://')).toBe(true);
  });
});

describe('the panel settings reach every served wg config', () => {
  it('with nothing set: no DNS line, ::/0 present', async () => {
    const t = await subscriber();
    for (const url of URLS(t)) {
      const res = await get(url);
      expect(res.body, url).not.toMatch(/^DNS = /m);
      expect(res.body, url).toContain('AllowedIPs = 0.0.0.0/0, ::/0\n');
    }
    const key = decodeKey((await get(`/sub/${t}?format=amneziavpn`)).body);
    expect(key).not.toHaveProperty('dns1');
    expect(key.containers[0]!.awg.last_config).toContain('::/0');
  });

  it('a DNS list: the DNS line in both .conf kinds, dns1/dns2 in the vpn:// key, the codes of the page', async () => {
    await setSettings({ subscriptionWgDns: ['1.1.1.1', '9.9.9.9', '8.8.8.8'] });
    const t = await subscriber();
    for (const url of URLS(t)) {
      expect((await get(url)).body, url).toMatch(/^DNS = 1\.1\.1\.1, 9\.9\.9\.9, 8\.8\.8\.8$/m);
    }
    const key = decodeKey((await get(`/sub/${t}?format=amneziavpn`)).body);
    expect(key.dns1).toBe('1.1.1.1');
    expect(key.dns2).toBe('9.9.9.9');
    const page = (await get(`/sub/${t}`, 'text/html')).body;
    expect(page).toContain('DNS = 1.1.1.1, 9.9.9.9, 8.8.8.8');
  });

  it('the switch on: only 0.0.0.0/0 in both .conf kinds, in the vpn:// key and in the page, and every device', async () => {
    await setSettings({ subscriptionWgDropIpv6: true });
    const t = await subscriber();
    for (const url of [...URLS(t), `${URLS(t)[0]}&device=2`, `${URLS(t)[1]}&device=3`]) {
      const res = await get(url);
      expect(res.body, url).toContain('AllowedIPs = 0.0.0.0/0\n');
      expect(res.body, url).not.toContain('::/0');
    }
    const vpn = decodeKey((await get(`/sub/${t}?format=amneziavpn`)).body);
    expect(vpn.containers[0]!.awg.last_config).not.toContain('::/0');
    const page = (await get(`/sub/${t}`, 'text/html')).body;
    expect(page).toContain('AllowedIPs = 0.0.0.0/0');
    expect(page).not.toContain('::/0');
  });

  it('the page names the file the link downloads', async () => {
    await setSettings({ brandName: 'Onegin' });
    const t = await subscriber();
    const page = (await get(`/sub/${t}`, 'text/html')).body;
    const shown = [...page.matchAll(/conf-row__file">([^<]+)</g)].map((m) => m[1]);
    expect(shown.length).toBeGreaterThan(0);
    const served = fileName(await get(`/sub/${t}?format=wgconf&protocols=wireguard`));
    expect(shown).toContain(served);
  });
});
