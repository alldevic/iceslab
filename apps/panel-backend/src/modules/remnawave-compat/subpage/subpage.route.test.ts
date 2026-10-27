import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * The install documents through the compatibility API: the shop asks for one
 * subscription's document by its short uuid (the subscription token), then for
 * the shared list and its entry. What comes back is what the subscription page
 * shows; `{}` where there is nothing to say, as the routes always answered.
 */

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
let cleanDatabase: () => Promise<void>;
let SHARED: string;
const PREFIX = 'rw';
const adminToken = `icp_subpage_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const bearer = () => ({ authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_PREFIX'] = PREFIX;
  const [{ buildApp }, prismaMod, db, svc] = await Promise.all([
    import('../../../app.js'),
    import('../../../prisma.js'),
    import('../../../../tests/helpers/db.js'),
    import('./subpage.service.js'),
  ]);
  prisma = prismaMod.prisma;
  cleanDatabase = db.cleanDatabase;
  SHARED = svc.SHARED_SUBPAGE_CONFIG_UUID;
  app = await buildApp();
  await app.ready();
});

beforeEach(async () => {
  await cleanDatabase();
  await prisma.apiToken.create({ data: { name: 'subpage-admin', tokenHash: sha(adminToken), scopes: [] } });
});

afterAll(async () => {
  await cleanDatabase();
  await app.close();
  await prisma.$disconnect();
});

let seq = 0;

/** A user in a squad holding one xray profile bound to an online node. */
async function subscriber(): Promise<string> {
  seq++;
  const node = await prisma.node.create({
    data: { name: `sp-node-${seq}`, address: `sp${seq}.test`, status: 'online', heartbeatSecret: Buffer.alloc(32) },
  });
  const profile = await prisma.profile.create({
    data: { name: `sp-prof-${seq}`, protocol: 'xray', config: { security: 'none', subprotocol: 'vless', network: 'raw' } },
  });
  const binding = await prisma.profileNodeBinding.create({
    data: { profileId: profile.id, nodeId: node.id, port: 443, transport: 'tcp' },
  });
  await prisma.host.create({ data: { bindingId: binding.id, remark: 'Default' } });
  const group = await prisma.group.create({ data: { name: `sp-squad-${seq}` } });
  await prisma.groupProfile.create({ data: { groupId: group.id, profileId: profile.id } });
  const res = await app.inject({
    method: 'POST',
    url: `/${PREFIX}/api/users`,
    headers: bearer(),
    payload: { username: `sp_user_${seq}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  const user = await prisma.user.findFirst({ where: { numericId: BigInt(res.json().response.id) } });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: user.id } });
  return user.subscriptionToken as string;
}

const get = (url: string) => app.inject({ method: 'GET', url: `/${PREFIX}/api${url}`, headers: bearer() });

describe('the install documents of the compatibility API', () => {
  it('answers a subscription with the page\'s apps and the person\'s own link', async () => {
    const token = await subscriber();
    const res = await get(`/subscriptions/subpage-config/${token}`);
    expect(res.statusCode, res.body).toBe(200);
    const doc = res.json().response;
    expect(doc.version).toBe('1');
    const happ = doc.platforms.ios.apps.find((a: { name: string }) => a.name === 'Happ');
    const link = happ.blocks.flatMap((b: { buttons: { type: string; link: string }[] }) => b.buttons).find((b: { type: string }) => b.type === 'subscriptionLink').link;
    expect(link).toMatch(new RegExp(`^happ://add/https?://.+/${token}$`));
  });

  it('is not a client fetching its config: nothing lands in the request history', async () => {
    const token = await subscriber();
    await get(`/subscriptions/subpage-config/${token}`);
    expect(await prisma.subscriptionRequestHistory.count()).toBe(0);
  });

  it('answers {} for a token it does not know, and for a disabled subscription', async () => {
    expect((await get('/subscriptions/subpage-config/nope')).json().response).toEqual({});
    const token = await subscriber();
    await prisma.user.update({ where: { subscriptionToken: token }, data: { status: 'disabled' } });
    expect((await get(`/subscriptions/subpage-config/${token}`)).json().response).toEqual({});
  });

  it('lists the shared document and answers it by its uuid, with the shop\'s placeholder for the link', async () => {
    expect((await get('/subscription-page-configs')).json().response).toEqual({ total: 0, configs: [] });
    await subscriber();
    const list = (await get('/subscription-page-configs')).json().response;
    expect(list.total).toBe(1);
    expect(list.configs[0]).toMatchObject({ uuid: SHARED, viewPosition: 0 });
    const doc = (await get(`/subscription-page-configs/${SHARED}`)).json().response;
    expect(JSON.stringify(doc)).toContain('happ://add/{{SUBSCRIPTION_LINK}}');
    expect((await get('/subscription-page-configs/11111111-1111-1111-1111-111111111111')).json().response).toEqual({});
  });
});
