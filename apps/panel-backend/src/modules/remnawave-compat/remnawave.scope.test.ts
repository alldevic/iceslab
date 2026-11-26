import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { requiredCompatScope as RequiredCompatScope } from '../auth/scope.hook.js';

// The facade's scope mapping: what a token with limited scopes may reach through
// /<prefix>/api/*, and that its replies pass the same secret redaction as the
// native API (A-109). Facade on from before the first import of app/config.

const PREFIX = 'rw';
// A static import of the hook would load config before the flag is set below.
let requiredCompatScope: typeof RequiredCompatScope;
const need = (method: string, path: string) => requiredCompatScope(method, `/${PREFIX}/api/${path}`, PREFIX);

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_PREFIX'] = PREFIX;
  ({ requiredCompatScope } = await import('../auth/scope.hook.js'));
});

describe('requiredCompatScope', () => {
  it('maps a Remnawave resource to the native scope guarding the same data', () => {
    expect(need('GET', 'users')).toBe('users:read');
    expect(need('POST', 'users')).toBe('users:write');
    expect(need('PATCH', 'users')).toBe('users:write');
    expect(need('POST', 'users/:ref/actions/revoke')).toBe('users:write');
    expect(need('GET', 'internal-squads')).toBe('squads:read');
    expect(need('GET', 'internal-squads/:uuid/accessible-nodes')).toBe('squads:read');
    expect(need('GET', 'nodes')).toBe('nodes:read');
    expect(need('POST', 'nodes/:uuid/actions/restart')).toBe('nodes:write');
    expect(need('GET', 'hosts')).toBe('hosts:read');
    expect(need('GET', 'hwid/devices/:ref')).toBe('hwid-devices:read');
    expect(need('POST', 'hwid/devices/delete')).toBe('hwid-devices:write');
    expect(need('GET', 'system/metadata')).toBe('system:read');
  });

  it('dropping connections and the bulk squad update change users, so they need users:write', () => {
    expect(need('POST', 'connections/drop')).toBe('users:write');
    expect(need('POST', 'users/bulk/update-squads')).toBe('users:write');
  });

  it('squad bulk actions change users, so they need users:write', () => {
    expect(need('POST', 'internal-squads/:uuid/bulk-actions/add-many-users')).toBe('users:write');
    expect(need('DELETE', 'internal-squads/:uuid/bulk-actions/remove-many-users')).toBe('users:write');
  });

  it('a user traffic figure is users:read, system statistics dashboard:read', () => {
    expect(need('GET', 'bandwidth-stats/users/:ref')).toBe('users:read');
    expect(need('GET', 'bandwidth-stats/nodes/:uuid/users')).toBe('users:read');
    expect(need('POST', 'bandwidth-stats/nodes/users')).toBe('users:read');
    expect(need('POST', 'bandwidth-stats/nodes/usage')).toBe('users:read');
    expect(need('GET', 'bandwidth-stats/nodes')).toBe('dashboard:read');
    expect(need('GET', 'system/stats')).toBe('dashboard:read');
    expect(need('GET', 'system/stats/bandwidth')).toBe('dashboard:read');
    expect(need('GET', 'system/stats/nodes')).toBe('dashboard:read');
  });

  it('is default-deny for an unmapped segment, a foreign prefix or a native url', () => {
    expect(need('GET', 'something-new')).toBeNull();
    expect(requiredCompatScope('GET', '/other/api/users', PREFIX)).toBeNull();
    expect(requiredCompatScope('GET', '/api/users', PREFIX)).toBeNull();
    expect(requiredCompatScope('GET', undefined, PREFIX)).toBeNull();
  });
});

describe('facade scopes on the wire', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const tag = Date.now();
  const tokens = {
    nodesRead: `icp_rwscope_nodes_${tag}`,
    usersRead: `icp_rwscope_users_${tag}`,
    full: `icp_rwscope_full_${tag}`,
  };
  let nodeId: string | null = null;
  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url: `/${PREFIX}/api/${url}`, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
    process.env['REMNAWAVE_COMPAT_PREFIX'] = PREFIX;
    const [{ buildApp }, prismaMod] = await Promise.all([import('../../app.js'), import('../../prisma.js')]);
    prisma = prismaMod.prisma;
    app = await buildApp();
    await app.ready();
    await prisma.apiToken.createMany({
      data: [
        { name: 'rwscope-nodes', tokenHash: sha(tokens.nodesRead), scopes: ['nodes:read'] },
        { name: 'rwscope-users', tokenHash: sha(tokens.usersRead), scopes: ['users:read'] },
        { name: 'rwscope-full', tokenHash: sha(tokens.full), scopes: [] },
      ],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    if (nodeId) await prisma.node.deleteMany({ where: { id: nodeId } });
    await prisma.apiToken.deleteMany({ where: { tokenHash: { in: Object.values(tokens).map(sha) } } });
    await app.close();
  });

  it('a token is refused outside its scope and served inside it', async () => {
    expect((await get('nodes', tokens.nodesRead)).statusCode).toBe(200);
    for (const url of ['hosts', 'internal-squads', 'system/stats', 'system/metadata', 'hwid/devices/stats']) {
      const res = await get(url, tokens.nodesRead);
      expect(res.statusCode, url).toBe(403);
    }
    expect((await get('nodes', tokens.usersRead)).statusCode).toBe(403);
    expect((await get('users', tokens.usersRead)).statusCode).toBe(200);
  });

  it('a scoped token cannot restart a node without nodes:write', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/${PREFIX}/api/nodes/actions/restart-all`,
      headers: { authorization: `Bearer ${tokens.nodesRead}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('what a restricted token reads goes through the secret redaction, as natively', async () => {
    // The nodes reply holds no real server secret, so the redaction is made
    // visible: one of the keys it would cut is named after a key of the reply.
    const { SERVER_SECRET_KEYS } = await import('../auth/token-secrets.js');
    const keys = SERVER_SECRET_KEYS as Set<string>;
    keys.add('usersOnline');
    try {
      // The page is a list: a node of its own makes sure the keys meet the reply.
      nodeId = (
        await prisma.node.create({
          data: { name: `rwscope-${tag}`, address: `rwscope-${tag}.test:1337`, heartbeatSecret: Buffer.alloc(32) },
        })
      ).id;
      const restricted = (await get('nodes', tokens.nodesRead)).json().response as Record<string, unknown>[];
      const full = (await get('nodes', tokens.full)).json().response as Record<string, unknown>[];
      expect(full.length).toBeGreaterThan(0);
      expect(full.every((n) => 'usersOnline' in n)).toBe(true);
      expect(restricted.length).toBe(full.length);
      expect(restricted.some((n) => 'usersOnline' in n)).toBe(false);
    } finally {
      keys.delete('usersOnline');
    }
  });
});
