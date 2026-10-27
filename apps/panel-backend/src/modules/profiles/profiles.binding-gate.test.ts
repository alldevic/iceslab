import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CoreStatus } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { observedCores } from '../nodes/nodes.cron.js';

/**
 * A-161: four ways onto a node, and the node's facts were asked on three. The
 * host form (which creates the binding under a new host) did not ask the
 * engine list, and an engine change did not ask the core's own report. One
 * gate now (assertBindingFitsNode) for both ways a binding is made, and the
 * engine change asks the core too.
 */
let app: FastifyInstance;
let token: string;
let seq = 0;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
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

const auth = () => ({ authorization: `Bearer ${token}` });

const REALITY = {
  subprotocol: 'vless',
  security: 'reality',
  realityDest: 'www.microsoft.com:443',
  realityServerNames: ['www.microsoft.com'],
  realityPrivateKey: 'k'.repeat(43),
  realityPublicKey: 'p'.repeat(43),
  realityShortIds: ['0123abcd'],
  network: 'raw',
};

async function makeNode(): Promise<string> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers: auth(),
    payload: { name: `bg-node-${seq}`, address: `bg-${seq}.test`, protocol: 'xray' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

async function makeProfile(engine?: string): Promise<string> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: auth(),
    payload: { name: `bg-profile-${seq}`, protocol: 'xray', config: REALITY, ...(engine ? { engine } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

async function report(nodeId: string, cores: Partial<CoreStatus>[]) {
  await prisma.node.update({
    where: { id: nodeId },
    data: {
      cores: observedCores(
        cores.map((c) => ({ running: true, ...c }) as CoreStatus),
        new Date().toISOString(),
        'amd64',
      ) as unknown as object,
    },
  });
}

describe('the binding gate', () => {
  it('refuses a host for a sing-box profile on a node that reported its engines without sing-box, as the bindings route does', async () => {
    const nodeId = await makeNode();
    const profileId = await makeProfile('singbox');
    // An agent before 23.09: names the engine, sends no row for a core it lacks.
    await report(nodeId, [{ name: 'xray', engine: 'xray', installed: true }]);

    const viaHost = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: auth(),
      payload: { profileId, nodeId, port: 8443, remark: 'h' },
    });
    const viaBinding = await app.inject({
      method: 'POST',
      url: '/api/bindings',
      headers: auth(),
      payload: { profileId, nodeId, port: 8443 },
    });
    for (const res of [viaHost, viaBinding]) {
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        error: 'PROFILE_DOES_NOT_RUN_ON_NODE',
        nodeName: 'bg-node-1',
        neededEngine: 'singbox',
      });
    }
    expect(await prisma.profileNodeBinding.count()).toBe(0);
    expect(await prisma.host.count()).toBe(0);
  });

  it('refuses moving a deployed profile onto an engine whose core the node reports refused, and keeps the engine', async () => {
    const nodeId = await makeNode();
    const profileId = await makeProfile('singbox');
    // sing-box fine, xray a known-bad version (26.9.8, XTLS/REALITY ML-KEM).
    await report(nodeId, [
      { name: 'xray', engine: 'singbox', installed: true, version: '1.13.14' },
      { name: 'xray', engine: 'xray', installed: true, version: '26.9.8' },
    ]);
    const bound = await app.inject({
      method: 'POST',
      url: '/api/bindings',
      headers: auth(),
      payload: { profileId, nodeId, port: 8443 },
    });
    expect(bound.statusCode, bound.body).toBe(201);

    const move = await app.inject({
      method: 'PUT',
      url: `/api/profiles/${profileId}`,
      headers: auth(),
      payload: { engine: 'xray' },
    });
    expect(move.statusCode, move.body).toBe(409);
    expect(JSON.parse(move.body)).toMatchObject({
      error: 'CORE_VERSION_REFUSED',
      engine: 'xray',
      version: '26.9.8',
      verdict: 'known-bad',
    });
    expect((await prisma.profile.findUniqueOrThrow({ where: { id: profileId } })).engine).toBe('singbox');
  });
});
