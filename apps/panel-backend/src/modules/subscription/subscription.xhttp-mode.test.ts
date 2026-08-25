import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { registerBindingsCacheBust } from './subscription.bindings-cache.js';

/**
 * The other half of `formats/xhttp-mode.test.ts`. That file proves each renderer
 * emits the mode it is handed; this one proves anything ever hands it one.
 *
 * They are separate on purpose. The renderers were not the reason the operator's
 * `xhttpMode` reached no client: the field simply never travelled. It has been in
 * the profile schema, the shared config type and the node's renderer since B3,
 * and the subscription side read the config through a narrower local interface
 * that did not name it - so `cfg.xhttpMode` was not wrong, it was unreachable.
 * A test that stops at the renderers cannot see that, which is how a fix that
 * changes six files can leave the behaviour exactly where it was.
 *
 * So this goes through the real API: profile saved over HTTP, served subscription
 * read back, and the assertion is on what the client is handed.
 */
let app: FastifyInstance;
let token: string;

beforeAll(() => registerBindingsCacheBust());

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
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

/** REALITY over XHTTP - the pairing the panel's own recipes recommend - with a
 *  framing the operator chose. This is the configuration that was broken: an
 *  `auto` client under REALITY frames as stream-one, and a packet-up server
 *  answers it 400. */
async function seed(xhttpMode: string) {
  const body = async (res: { body: string }) => JSON.parse(res.body);
  const profile = await body(
    await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: auth(),
      payload: {
        name: 'xhttp-profile',
        protocol: 'xray',
        config: {
          security: 'reality',
          realityDest: 'www.microsoft.com:443',
          realityServerNames: ['www.microsoft.com'],
          realityPrivateKey: 'k'.repeat(43),
          realityPublicKey: 'p'.repeat(43),
          realityShortIds: ['0123abcd'],
          network: 'xhttp',
          path: '/dl',
          xhttpMode,
        },
      },
    }),
  );
  expect(profile.id, `profile refused: ${JSON.stringify(profile)}`).toBeTruthy();
  const node = await body(
    await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: auth(),
      payload: { name: 'xhttp-node', address: 'xh.example.com', protocol: 'xray' },
    }),
  );
  await app.inject({
    method: 'POST',
    url: '/api/hosts',
    headers: auth(),
    payload: { profileId: profile.id, nodeId: node.id, port: 443, remark: 'Direct' },
  });
  const squad = await body(
    await app.inject({
      method: 'POST',
      url: '/api/squads',
      headers: auth(),
      payload: { name: 'xhttp-squad', profileIds: [profile.id] },
    }),
  );
  const user = await body(
    await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(),
      payload: { username: 'xhttp_user', groupIds: [squad.id] },
    }),
  );
  return { profile, user };
}

async function fetchSub(subToken: string, format: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/sub/${subToken}?format=${format}` });
  expect(res.statusCode).toBe(200);
  return format === 'plain' ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
}

describe('the framing an operator saves reaches the subscription', () => {
  it('carries a chosen mode into the link and into the config formats', async () => {
    const { user } = await seed('stream-one');

    const plain = await fetchSub(user.subscriptionToken, 'plain');
    const uri = plain.split('\n').filter(Boolean)[0];
    expect(new URL(uri).searchParams.get('mode')).toBe('stream-one');

    const xray = JSON.parse(await fetchSub(user.subscriptionToken, 'xrayjson'));
    expect(xray.outbounds[0].streamSettings.xhttpSettings.mode).toBe('stream-one');

    expect(await fetchSub(user.subscriptionToken, 'clash')).toContain('mode: stream-one');
  });

  it('carries a different one just as faithfully', async () => {
    // Not a duplicate of the case above: one value cannot tell a config that
    // travels from a constant that happens to match the fixture. packet-up is
    // also the specific mode a REALITY node fails on, since an `auto` client
    // there frames as stream-one and the server refuses it.
    const { user } = await seed('packet-up');

    const plain = await fetchSub(user.subscriptionToken, 'plain');
    expect(new URL(plain.split('\n').filter(Boolean)[0]).searchParams.get('mode')).toBe(
      'packet-up',
    );
    const xray = JSON.parse(await fetchSub(user.subscriptionToken, 'xrayjson'));
    expect(xray.outbounds[0].streamSettings.xhttpSettings.mode).toBe('packet-up');
  });

  it('leaves the default off the link and explicit in the configs', async () => {
    const { user } = await seed('auto');

    const plain = await fetchSub(user.subscriptionToken, 'plain');
    expect(new URL(plain.split('\n').filter(Boolean)[0]).searchParams.has('mode')).toBe(false);
    const xray = JSON.parse(await fetchSub(user.subscriptionToken, 'xrayjson'));
    expect(xray.outbounds[0].streamSettings.xhttpSettings.mode).toBe('auto');
  });
});
