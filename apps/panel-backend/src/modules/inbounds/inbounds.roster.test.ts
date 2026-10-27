import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AddUserRequest, AddUsersRequest, AddUsersResponse } from '@iceslab/shared';
import { ADD_USERS_BATCH, sendRoster } from './inbounds.queue.js';
import { NodeRequestError } from '../nodes/nodes.transport.js';

// A-112: the roster after a push used to be one /addUser per user, thirty
// thousand requests on every push for an operator that size.

function roster(n: number): AddUserRequest[] {
  return Array.from({ length: n }, (_, i) => ({
    userId: `u-${i}`,
    shortId: `s${i}`,
    username: `user${i}`,
    inboundIds: ['i-1'],
    credentials: { xrayUuid: `x-${i}` },
  }));
}

function fakeTransport(answer?: (req: AddUsersRequest) => AddUsersResponse | Error) {
  const batches: AddUsersRequest[] = [];
  const singles: AddUserRequest[] = [];
  return {
    batches,
    singles,
    addUsers: vi.fn(async (req: AddUsersRequest) => {
      batches.push(req);
      const res = answer?.(req) ?? { results: req.users.map((u) => ({ userId: u.userId, ok: true })) };
      if (res instanceof Error) throw res;
      return res;
    }),
    addUser: vi.fn(async (req: AddUserRequest) => {
      singles.push(req);
    }),
  };
}

describe('the roster to a node (A-112)', () => {
  it('goes in batches, in order, and sends no request per user', async () => {
    const t = fakeTransport();
    const users = roster(ADD_USERS_BATCH * 2 + 17);
    expect(await sendRoster(t, 'n1', users)).toBe(0);
    expect(t.batches.map((b) => b.users.length)).toEqual([ADD_USERS_BATCH, ADD_USERS_BATCH, 17]);
    expect(t.batches.flatMap((b) => b.users)).toEqual(users);
    expect(t.singles).toEqual([]);
  });

  it('sends nothing for no users', async () => {
    const t = fakeTransport();
    expect(await sendRoster(t, 'n1', [])).toBe(0);
    expect(t.batches).toEqual([]);
  });

  it('falls back to one request per user on an agent without the route', async () => {
    const t = fakeTransport(() => new NodeRequestError('Node n1 returned 404: Not Found', 404, null));
    const users = roster(30);
    expect(await sendRoster(t, 'n1', users)).toBe(0);
    expect(t.batches).toHaveLength(1);
    expect(t.singles).toEqual(users);
  });

  it('counts the users the agent refused, and those it did not answer for', async () => {
    const t = fakeTransport((req) => ({
      results: req.users.slice(0, -1).map((u, i) => ({ userId: u.userId, ok: i !== 1, error: i === 1 ? 'x' : undefined })),
    }));
    expect(await sendRoster(t, 'n1', roster(5))).toBe(2);
  });

  it('counts a failed batch whole and still sends the next', async () => {
    let first = true;
    const t = fakeTransport((req) => {
      if (first) {
        first = false;
        return new NodeRequestError('Node n1 returned 500: boom', 500, null);
      }
      return { results: req.users.map((u) => ({ userId: u.userId, ok: true })) };
    });
    expect(await sendRoster(t, 'n1', roster(ADD_USERS_BATCH + 3))).toBe(ADD_USERS_BATCH);
    expect(t.batches).toHaveLength(2);
    expect(t.singles).toEqual([]);
  });

  it('fits a batch of the longest values under the agent body cap', () => {
    // The agent refuses a body over maxRequestBodyBytes with 413, which would
    // turn every push into a roster that never lands. Every field at the
    // longest it takes, and twenty inbounds on the node.
    const serverGo = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../../apps/node/internal/server/server.go'),
      'utf8',
    );
    const shift = /^const maxRequestBodyBytes = 1 << (\d+)$/m.exec(serverGo)?.[1];
    expect(shift, 'maxRequestBodyBytes was not found in server.go').toBeDefined();
    const cap = 1 << Number(shift);

    const uuid = '00000000-0000-0000-0000-000000000000';
    const key44 = 'A'.repeat(43) + '=';
    const longest: AddUserRequest = {
      userId: uuid,
      shortId: 'f'.repeat(16),
      username: 'u'.repeat(64),
      inboundIds: Array.from({ length: 20 }, () => uuid),
      credentials: {
        xrayUuid: uuid,
        hysteriaPassword: 'p'.repeat(64),
        amneziawgPublicKey: key44,
        amneziawgAllowedIp: '255.255.255.255',
        amneziawgAllowedIp3: '255.255.255.255',
        naivePassword: 'p'.repeat(64),
        tuicUuid: uuid,
        tuicPassword: 'p'.repeat(64),
        anytlsPassword: 'p'.repeat(64),
        shadowtlsPassword: 'p'.repeat(64),
      },
    };
    const body = JSON.stringify({ users: Array.from({ length: ADD_USERS_BATCH }, () => longest) });
    expect(Buffer.byteLength(body)).toBeLessThan(cap / 2);
  });
});
