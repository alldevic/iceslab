// The install-config route end to end: a real subscription in the database, the
// facade route the shop actually calls, and the document that comes back.
//
// `subpage-config.test.ts` next door tests the BUILDER — given protocols and
// nodes, what document. Everything between a subscription token and those
// arguments was untested: resolving the token, refusing a revoked or expired
// one, gating the tunnel node list on `wgconf`, and not recording the shop's
// call as if a client had fetched its config. The contract test reaches this
// route with a deliberately ABSENT token, so it only ever saw the empty answer.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const PREFIX = 'rw';
const apiToken = `icp_subpage_${Date.now()}`;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
let adminToken: string;

/** The facade wraps every answer in `{ response: … }`. */
function body(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as { response?: Record<string, unknown> };
  return parsed.response ?? (parsed as Record<string, unknown>);
}

async function api(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${adminToken}` },
    ...(payload === undefined ? {} : { payload }),
  });
  if (res.statusCode >= 300) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body) as Record<string, unknown>;
}

async function guide(token: string): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'GET',
    url: `/${PREFIX}/api/subscriptions/subpage-config/${token}`,
    headers: { authorization: `Bearer ${apiToken}` },
  });
  expect(res.statusCode).toBe(200);
  return body(res.body);
}

function appNames(doc: Record<string, unknown>): Set<string> {
  const platforms = (doc['platforms'] ?? {}) as Record<string, { apps: { name: string }[] }>;
  return new Set(Object.values(platforms).flatMap((p) => p.apps.map((a) => a.name)));
}

/** A user whose only squad carries one AmneziaWG profile on one node. */
async function seedAwgUser(suffix: string): Promise<{ token: string; bindingId: string }> {
  const node = await api('POST', '/api/nodes', {
    name: `sp-node-${suffix}`,
    address: `10.9.0.${suffix}`,
  });
  const profile = await api('POST', '/api/profiles', {
    name: `sp-awg-${suffix}`,
    protocol: 'amneziawg',
    config: {
      subnet: '10.90.0.0/24',
      serverPrivateKey: 'aP8lgNU9c2vTGSvljeH1JO1qfCWQ6LwdVT92/RBO/FA=',
      serverPublicKey: 'BQ6TIcR/TaTqtY4slJvnVj0I95pkC3z7t4HA54i8qVA=',
      obfuscation: {},
    },
  });
  const binding = await api('POST', '/api/bindings', {
    profileId: profile['id'],
    nodeId: node['id'],
    port: 51820,
  });
  const squad = await api('POST', '/api/squads', {
    name: `sp-squad-${suffix}`,
    profileIds: [profile['id']],
  });
  const user = await api('POST', '/api/users', {
    username: `sp-user-${suffix}`,
    groupIds: [squad['id']],
  });
  return { token: user['subscriptionToken'] as string, bindingId: binding['id'] as string };
}

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_PREFIX'] = PREFIX;
  const [{ registerBindingsCacheBust }] = await Promise.all([
    import('../../subscription/subscription.bindings-cache.js'),
  ]);
  // Same reason as in subscription.routes.test.ts: the binding cache listens to
  // domain events and only `index.ts` subscribes it. Without this a test that
  // edits a host and re-reads the guide reads the world before the edit.
  registerBindingsCacheBust();
});

beforeEach(async () => {
  const [{ buildApp }, prismaMod, { cleanDatabase }, { registerAndLogin }] = await Promise.all([
    import('../../../app.js'),
    import('../../../prisma.js'),
    import('../../../../tests/helpers/db.js'),
    import('../../../../tests/helpers/auth.js'),
  ]);
  prisma = prismaMod.prisma;
  app = await buildApp();
  await app.ready();
  await cleanDatabase();
  adminToken = await registerAndLogin(app);
  await prisma.apiToken.create({ data: { name: 'subpage', tokenHash: sha(apiToken), scopes: [] } });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  const { closeRedis } = await import('../../../lib/redis.js');
  await closeRedis();
});

describe('GET /subscriptions/subpage-config/:shortUuid', () => {
  it('answers with the clients THIS buyer can actually use', async () => {
    const { token } = await seedAwgUser('1');
    const doc = await guide(token);

    expect(doc['version']).toBe('1');
    const names = appNames(doc);
    expect(names).toContain('AmneziaVPN');
    // Hiddify speaks AmneziaWG but is offered as a subscription deep link, and
    // this buyer's subscription is empty. Its absence is the whole point.
    expect(names).not.toContain('Hiddify');
  });

  it('does not record the shop asking as a client fetching', async () => {
    const { token } = await seedAwgUser('2');
    const user = await prisma.user.findFirstOrThrow({ where: { subscriptionToken: token } });
    const rows = async (): Promise<number> =>
      prisma.subscriptionRequestHistory.count({ where: { userId: user.id } });

    expect(await rows()).toBe(0);
    await guide(token);
    await guide(token);
    // The insights dashboard counts this table — distinct users, the
    // requests-per-hour histogram, the client-family split. Rows written here
    // carry no IP and no User-Agent and would be traffic no client generated.
    expect(await rows(), 'the shop fetching a guide was recorded as a subscription request').toBe(
      0,
    );

    // Control: the same subscription, fetched the way a client fetches it, IS
    // recorded — otherwise this test would also pass with the audit removed.
    const res = await app.inject({
      method: 'GET',
      url: `/sub/${token}`,
      headers: { 'user-agent': 'Happ/1.0' },
    });
    expect(res.statusCode).toBe(200);
    expect(await rows()).toBe(1);
  });

  it('drops the tunnel clients when the host is switched off for wgconf', async () => {
    const { token, bindingId } = await seedAwgUser('3');
    expect(appNames(await guide(token))).toContain('AmneziaVPN');

    const hosts = (await api('GET', `/api/hosts?bindingId=${bindingId}`)) as {
      hosts: { id: string }[];
    };
    await api('PUT', `/api/hosts/${hosts.hosts[0].id}`, { disableForFormats: ['wgconf'] });

    // Every one of that buyer's cards leads to `?format=wgconf`, which now
    // serves nothing, so the panel has nothing to say and the shop keeps its
    // own guide rather than showing dead buttons.
    expect(await guide(token)).toEqual({});
  });

  it('says nothing about a subscription it cannot serve', async () => {
    expect(await guide('nosuchtokenatall')).toEqual({});

    const { token } = await seedAwgUser('4');
    await prisma.user.updateMany({
      where: { subscriptionToken: token },
      data: { status: 'expired' },
    });
    // An expired subscription is not an error on a display route: the shop must
    // render something, and its own guide is the right something.
    expect(await guide(token)).toEqual({});
  });
});
