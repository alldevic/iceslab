import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { clientSecurityLayer } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { RecipeSchema, parseRecipe } from '../recipes/recipes.schemas.js';

/**
 * A-230: one rule for the security layer a client sees, and vmess without
 * REALITY: refused when asked for, none when not said, and a row stored as
 * REALITY before the refusal served as none.
 */

describe('clientSecurityLayer (shared)', () => {
  it('a host override of tls or none wins, else the profile, REALITY when it says nothing', () => {
    expect(clientSecurityLayer({ security: 'reality' })).toBe('default');
    expect(clientSecurityLayer({})).toBe('default');
    expect(clientSecurityLayer({ security: 'tls' })).toBe('tls');
    expect(clientSecurityLayer({ security: 'none' })).toBe('none');
    expect(clientSecurityLayer({ security: 'reality' }, 'tls')).toBe('tls');
    expect(clientSecurityLayer({ security: 'tls' }, 'none')).toBe('none');
    expect(clientSecurityLayer({ security: 'tls' }, 'default')).toBe('tls');
    expect(clientSecurityLayer(null)).toBe('default');
  });

  it('vmess never rides REALITY: stored as REALITY or saying nothing, it is none', () => {
    expect(clientSecurityLayer({ subprotocol: 'vmess', security: 'reality' })).toBe('none');
    expect(clientSecurityLayer({ subprotocol: 'vmess' })).toBe('none');
    expect(clientSecurityLayer({ subprotocol: 'vmess', security: 'tls' })).toBe('tls');
    expect(clientSecurityLayer({ subprotocol: 'trojan', security: 'reality' })).toBe('default');
  });
});

describe('a recipe', () => {
  const recipe = (apply: Record<string, unknown>) => ({
    schemaVersion: 2,
    id: 'vmess-test',
    engine: 'native',
    protocol: 'xray',
    subprotocol: 'vmess',
    emoji: 'x',
    name: 'vmess',
    description: 'd',
    details: 'd',
    dpiResistance: 3,
    speed: 3,
    apply,
  });

  it('asking for vmess over REALITY is refused by name and dropped; tls is not', () => {
    const bad = RecipeSchema.safeParse(recipe({ xraySubprotocol: 'vmess', xraySecurity: 'reality' }));
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('vmess has no REALITY');
    expect(parseRecipe(recipe({ xraySubprotocol: 'vmess', xraySecurity: 'reality' }))).toBeNull();
    expect(parseRecipe(recipe({ xraySubprotocol: 'vmess', xraySecurity: 'tls' }))).not.toBeNull();
  });
});

describe('through the API and the subscription', () => {
  let app: FastifyInstance;
  let token: string;
  let seq = 0;

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
  const REALITY = {
    realityDest: 'www.microsoft.com:443',
    realityServerNames: ['www.microsoft.com'],
    realityPrivateKey: 'k'.repeat(43),
    realityPublicKey: 'p'.repeat(43),
    realityShortIds: ['0123abcd'],
  };

  async function create(config: Record<string, unknown>) {
    seq += 1;
    return app.inject({
      method: 'POST', url: '/api/profiles', headers: auth(),
      payload: { name: `vm-${seq}`, protocol: 'xray', config },
    });
  }

  it('vmess with no security is saved as none; vless with none said stays REALITY', async () => {
    const vmess = await create({ subprotocol: 'vmess', network: 'ws', path: '/w' });
    expect(vmess.statusCode, vmess.body).toBe(201);
    expect(JSON.parse(vmess.body).config.security).toBe('none');
    const vless = await create({ ...REALITY, subprotocol: 'vless' });
    expect(vless.statusCode, vless.body).toBe(201);
    expect(JSON.parse(vless.body).config.security).toBe('reality');
  });

  it('vmess asked for over REALITY is refused in words, on create and on an edit', async () => {
    const refused = await create({ ...REALITY, subprotocol: 'vmess', security: 'reality' });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('vmess has no REALITY');

    const ok = await create({ subprotocol: 'vmess', security: 'tls', tlsServerName: 'v.example.com' });
    expect(ok.statusCode, ok.body).toBe(201);
    const edit = await app.inject({
      method: 'PUT', url: `/api/profiles/${JSON.parse(ok.body).id}`, headers: auth(),
      payload: { config: { ...REALITY, subprotocol: 'vmess', security: 'reality' } },
    });
    expect(edit.statusCode).toBe(400);
    expect(edit.body).toContain('vmess has no REALITY');
  });

  it('a vmess row stored as REALITY (past the schema) is served as none: Quantumult X takes its WebSocket', async () => {
    const made = await create({ subprotocol: 'vmess', network: 'ws', path: '/w' });
    const profileId = JSON.parse(made.body).id as string;
    const row = await prisma.profile.findUniqueOrThrow({ where: { id: profileId }, select: { config: true } });
    await prisma.profile.update({
      where: { id: profileId },
      data: { config: { ...(row.config as Record<string, unknown>), ...REALITY, security: 'reality' } },
    });
    const node = await app.inject({
      method: 'POST', url: '/api/nodes', headers: auth(),
      payload: { name: 'vm-node', address: 'vm.test', protocol: 'xray' },
    });
    const binding = await app.inject({
      method: 'POST', url: '/api/bindings', headers: auth(),
      payload: { profileId, nodeId: JSON.parse(node.body).id, port: 443 },
    });
    expect(binding.statusCode, binding.body).toBe(201);
    const user = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'vm-user' } });
    const { subscriptionToken } = await prisma.user.findUniqueOrThrow({
      where: { id: JSON.parse(user.body).id as string }, select: { subscriptionToken: true },
    });

    const qx = await app.inject({ method: 'GET', url: `/sub/${subscriptionToken}?format=quantumultx` });
    expect(qx.statusCode).toBe(200);
    expect(qx.body).toMatch(/^vmess=.*obfs=ws/m);

    // The profile's /formats answer says the same.
    const formats = await app.inject({ method: 'GET', url: `/api/profiles/${profileId}/formats`, headers: auth() });
    const qxRow = (JSON.parse(formats.body) as { formats: { format: string; carried: boolean }[] }).formats.find(
      (f) => f.format === 'quantumultx',
    );
    expect(qxRow).toMatchObject({ carried: true });
  });
});
