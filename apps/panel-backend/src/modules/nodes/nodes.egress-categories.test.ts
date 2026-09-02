import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { addCategory } from '../geo/geo.categories.js';

/**
 * A node's own egress policy is checked against the geo vocabulary, like a
 * cascade's is.
 *
 * It was not, and the gap was invisible from the panel: `assertEgressCategories`
 * hung on the cascade path only, so `geoip:rus` on a NODE was accepted with a
 * 200 and pushed. The node's `xray -test` preflight is what saved it — it
 * refuses to swap in a config that will not load and keeps serving the old one,
 * measured live on the production entry, which never went down — but that
 * verdict lives in the node's journal. From the panel the save looked done and
 * the split silently did nothing.
 */

let app: FastifyInstance;
let token: string;
let nodeId: string;

const auth = () => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  const node = await prisma.node.create({
    data: {
      name: `egress-${Date.now()}`,
      address: 'egress.example.com:8443',
      heartbeatSecret: Buffer.alloc(32),
    },
  });
  nodeId = node.id;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const put = (hardening: unknown) =>
  app.inject({
    method: 'PUT',
    url: `/api/nodes/${nodeId}`,
    headers: auth(),
    payload: { hardening },
  });

describe('a node policy is judged before it reaches the node', () => {
  it('refuses a misspelled geoip category with 400', async () => {
    const res = await put({
      egressPolicy: [{ geoip: ['geoip:rus'], target: 'direct' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('rus');
  });

  it('accepts the spelling that works, so the check is not a blanket refusal', async () => {
    const res = await put({
      egressPolicy: [{ geoip: ['geoip:ru'], target: 'direct' }],
    });
    expect(res.statusCode).toBe(200);
    const saved = await prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect((saved.hardening as { egressPolicy: unknown[] }).egressPolicy).toHaveLength(1);
  });

  it('tells a node operator the truth about a custom category', async () => {
    // The cascade path answers "reference it as ext:". Here that would be a lie:
    // the custom .dat reaches a node only as a cascade fragment, which is why
    // NodeEgressPolicySchema refuses ext: on this scope outright.
    await addCategory({ name: 'ru-direct', enabled: true });
    const res = await put({
      egressPolicy: [{ geosite: ['geosite:ru-direct'], target: 'direct' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('cascade');
    expect(res.body).not.toContain('ext:geo-custom.dat');
  });

  it('leaves an edit that carries no policy alone', async () => {
    // The control: hardening is a blob with several unrelated flags, and a node
    // rename must not be refused because someone once saved a bad rule.
    const res = await put({ ufwLockdown: true });
    expect(res.statusCode).toBe(200);
  });
});
