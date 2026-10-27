import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MULTI_INBOUND_ADAPTERS, PROTOCOL_NAMES, SCOPED_USER_ENGINES, nativeEngineFor, userScopeGap } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { nodeUserScopeGaps } from './node-user-scope.js';
import { pushedBindingsWhere } from './pushed-bindings.js';

/**
 * A-204: where a squad's limit on a user does not hold on the node, by the
 * shared rule, checked against the agent's own sources.
 */

const CORE = join(dirname(fileURLToPath(import.meta.url)), '../../../../node/internal/core');
const adapters = Object.fromEntries(
  readdirSync(CORE)
    .filter((d) => existsSync(join(CORE, d, 'adapter.go')))
    .map((d) => [d, readFileSync(join(CORE, d, 'adapter.go'), 'utf8')]),
);

describe('the rule (shared userScopeGap)', () => {
  it('the engines with AddUserOn are the agent\'s, read from its sources', () => {
    expect(Object.keys(adapters)).toEqual(expect.arrayContaining(['xray', 'mieru', 'mtproto']));
    const scoped = Object.entries(adapters)
      .filter(([, code]) => /func \(a \*Adapter\) AddUserOn\(/.test(code))
      .map(([engine]) => engine)
      .sort();
    expect(scoped).toEqual([...SCOPED_USER_ENGINES].sort());
    expect(adapters.mtproto).toMatch(/single-secret/);
  });

  it('every protocol on its own engine: the gap is mtproto\'s, and a multi-inbound adapter\'s without AddUserOn', () => {
    for (const protocol of PROTOCOL_NAMES) {
      const engine = nativeEngineFor(protocol);
      const multi = MULTI_INBOUND_ADAPTERS.includes(`${protocol}|${engine}`);
      const want = protocol === 'mtproto' ? 'shared-secret' : multi && !SCOPED_USER_ENGINES.includes(engine) ? 'shared-users' : null;
      expect(userScopeGap({ protocol, effectiveEngine: engine }), protocol).toBe(want);
    }
    expect(userScopeGap({ protocol: 'tuic', effectiveEngine: 'singbox' })).toBeNull();
  });

  it('mtproto on mtprotoproxy holds the limit: a secret per user, taken off with them', () => {
    expect(adapters.mtprotoproxy).toMatch(/MtprotoSecret/);
    expect(adapters.mtprotoproxy).toMatch(/func \(a \*Adapter\) RemoveUser\(/);
    expect(userScopeGap({ protocol: 'mtproto', effectiveEngine: 'mtprotoproxy' })).toBeNull();
  });
});

describe('nodeUserScopeGaps', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis();
  });

  async function node(name: string): Promise<string> {
    return (await prisma.node.create({
      data: { name, address: `${name}.test`, protocol: 'xray', heartbeatSecret: Buffer.alloc(32) },
      select: { id: true },
    })).id;
  }
  async function bind(nodeId: string, name: string, protocol: string, port: number, enabled = true) {
    const p = await prisma.profile.create({ data: { name, protocol, config: {} }, select: { id: true } });
    return prisma.profileNodeBinding.create({ data: { nodeId, profileId: p.id, port, transport: 'tcp', enabled } });
  }

  it('two mieru inbounds on one node: both named; one alone: not; mtproto: always; xray: never', async () => {
    const n = await node('us-a');
    const m1 = await bind(n, 'mi-1', 'mieru', 2001);
    const m2 = await bind(n, 'mi-2', 'mieru', 2002);
    const mt = await bind(n, 'mt-1', 'mtproto', 443);
    await bind(n, 'xr-1', 'xray', 8443);
    await bind(n, 'xr-2', 'xray', 8444);
    const gaps = await nodeUserScopeGaps(n);
    expect(gaps.map((g) => [g.bindingId, g.gap]).sort()).toEqual(
      [[m1.id, 'shared-users'], [m2.id, 'shared-users'], [mt.id, 'shared-secret']].sort(),
    );
    expect(gaps.find((g) => g.bindingId === m1.id)).toMatchObject({ profileName: 'mi-1', protocol: 'mieru', port: 2001 });

    const lone = await node('us-b');
    await bind(lone, 'mi-solo', 'mieru', 2001);
    expect(await nodeUserScopeGaps(lone)).toEqual([]);
  });

  it('a disabled binding is not pushed and does not count', async () => {
    const n = await node('us-c');
    await bind(n, 'mi-on', 'mieru', 2001);
    await bind(n, 'mi-off', 'mieru', 2002, false);
    expect(await nodeUserScopeGaps(n)).toEqual([]);
  });

  it('a binding of a disabled profile is not pushed either: no shared secret, no second mieru', async () => {
    const n = await node('us-d');
    await bind(n, 'mi-live', 'mieru', 2001);
    const second = await bind(n, 'mi-dead', 'mieru', 2002);
    const mt = await bind(n, 'mt-dead', 'mtproto', 443);
    await prisma.profile.updateMany({ where: { id: { in: [second.profileId, mt.profileId] } }, data: { enabled: false } });
    expect(await nodeUserScopeGaps(n)).toEqual([]);
    // The push reads the same filter: what it would send is the one live mieru.
    const pushed = await prisma.profileNodeBinding.findMany({ where: pushedBindingsWhere(n), select: { profileId: true } });
    expect(pushed).toHaveLength(1);
  });
});
