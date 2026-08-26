// Redeeming a bootstrap token: the one unauthenticated route that hands out
// working credentials.
//
// The token IS the credential - 192 bits, fifteen minutes, one use - and what
// it buys is an mTLS client certificate plus the heartbeat token for that node.
// Measured before writing: the suite of 1542 stayed green with the single-use
// check deleted and green again with the TTL check deleted. Node creation and
// the install command are tested; nothing had ever redeemed a token.
//
// The two deleted checks are the whole security model of this route. Without
// single-use, a token pasted into a chat log, a shell history or a CI job is a
// permanent key to a node certificate. Without the TTL, so is one an operator
// generated and never used.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { decodeNodePayload } from '../keygen/keygen.service.js';
import { issueBootstrapToken } from './bootstrap.service.js';

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

async function makeNode(): Promise<string> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: `bs-${seq}`, address: `bs-${seq}.example.com`, protocol: 'xray' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

/** Issue through the admin route, the way an operator does. */
async function issue(nodeId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/nodes/${nodeId}/bootstrap`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).token as string;
}

const redeem = (t: string) => app.inject({ method: 'GET', url: `/api/internal/bootstrap/${t}` });

describe('a token buys exactly one working payload', () => {
  // Read the payload for what it DOES, not for its shape: the heartbeat token
  // inside it is presented to the endpoint that would authenticate the real
  // agent. A payload that merely has the field would pass a shape check and
  // still leave an installed node unable to poll.
  it('hands over credentials the node can actually use', async () => {
    const nodeId = await makeNode();
    const res = await redeem(await issue(nodeId));

    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    const payload = decodeNodePayload(res.body);
    expect(payload.nodeId).toBe(nodeId);
    expect(payload.nodeCertPem).toContain('BEGIN CERTIFICATE');
    expect(payload.nodeKeyPem).toContain('PRIVATE KEY');
    expect(payload.caCertPem).toContain('BEGIN CERTIFICATE');
    expect(payload.panelUrl).toBeTruthy();
    expect(
      payload.panelClientFingerprint,
      'without it the agent cannot pin the panel it accepts pushes from',
    ).toBeTruthy();

    const poll = await app.inject({
      method: 'GET',
      url: '/api/internal/nodes/me/status',
      headers: { authorization: `Bearer ${payload.heartbeatToken}` },
    });
    expect(
      poll.statusCode,
      'the heartbeat token shipped in the payload must authenticate against the ' +
        'endpoint the agent polls, or the installed node is deaf from the first minute',
    ).toBe(200);
    expect(JSON.parse(poll.body).status).toBe('active');
  });

  // Measured while proving this test: deleting the early `if (row.consumedAt)`
  // check does NOT change behaviour, because the atomic claim below already
  // enforces single-use - an already-consumed row matches nothing under
  // `consumedAt: null`, the update touches zero rows, and the same 410 comes
  // back. The check that actually holds this invariant is that claim, and the
  // two mutations that remove it (the claim's condition, and the zero-count
  // branch) both redden the concurrency test below.
  it('refuses the second redemption', async () => {
    const t = await issue(await makeNode());
    expect((await redeem(t)).statusCode).toBe(200);

    const again = await redeem(t);
    expect(
      again.statusCode,
      'a token in a shell history or a chat log must not be a second certificate',
    ).toBe(410);
    expect(JSON.parse(again.body).error).toBe('CONSUMED');

    const row = await prisma.nodeBootstrapToken.findFirstOrThrow({ where: { token: t } });
    expect(row.consumedAt).not.toBeNull();
  });

  // The claim in the source is race-safety, not just sequential single-use:
  // the row is marked consumed BEFORE the certificate is issued, and a lost
  // race is reported as consumed. Eight at once, for the reason recorded in
  // admin.service.test.ts - two concurrent calls did not overlap there and the
  // test passed against the very defect it named.
  it('hands the payload to exactly one of eight simultaneous redemptions', async () => {
    const t = await issue(await makeNode());

    const results = await Promise.all(Array.from({ length: 8 }, () => redeem(t)));
    const ok = results.filter((r) => r.statusCode === 200);
    const refused = results.filter((r) => r.statusCode === 410);

    expect(ok, 'only one caller may walk away with a certificate').toHaveLength(1);
    expect(refused).toHaveLength(7);
  });
});

describe('a token that should not work', () => {
  it('answers 404 to one nobody issued', async () => {
    const res = await redeem('bs_thisTokenWasNeverIssuedAtAll');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('NOT_FOUND');
  });

  // Fifteen minutes is the window an operator has to paste the install command.
  // A token that outlives it is a credential sitting in their clipboard history.
  it('answers 410 to an expired one', async () => {
    const nodeId = await makeNode();
    const t = await issue(nodeId);
    await prisma.nodeBootstrapToken.updateMany({
      where: { token: t },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await redeem(t);
    expect(res.statusCode).toBe(410);
    expect(JSON.parse(res.body).error).toBe('EXPIRED');
  });

  // One second either side of the deadline, so "expired" means the deadline
  // and not something near it.
  it('still works one second before the deadline', async () => {
    const t = await issue(await makeNode());
    await prisma.nodeBootstrapToken.updateMany({
      where: { token: t },
      data: { expiresAt: new Date(Date.now() + 1000) },
    });
    expect((await redeem(t)).statusCode).toBe(200);
  });

  // Deleting a node has to invalidate the install nobody ran yet. Otherwise a
  // token issued before the deletion still mints a certificate for a name the
  // panel no longer knows.
  it('answers 404 once the node is deleted', async () => {
    const nodeId = await makeNode();
    const t = await issue(nodeId);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/nodes/${nodeId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBeLessThan(300);

    const res = await redeem(t);
    expect(res.statusCode, 'a deleted node must not still be installable').toBe(404);
  });

});

describe('the token itself', () => {
  it('is a fresh unguessable string every time', async () => {
    const nodeId = await makeNode();
    const a = await issue(nodeId);
    const b = await issue(nodeId);

    expect(a).not.toBe(b);
    for (const t of [a, b]) {
      expect(t.startsWith('bs_'), 'the prefix is what makes it recognisable in a log').toBe(true);
      // 24 random bytes -> 32 base64url characters.
      expect(t.length).toBeGreaterThanOrEqual(3 + 32);
      expect(t.slice(3)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('expires fifteen minutes out', async () => {
    const nodeId = await makeNode();
    const before = Date.now();
    const { expiresAt } = await issueBootstrapToken(nodeId);
    const minutes = (expiresAt.getTime() - before) / 60_000;
    expect(minutes).toBeGreaterThan(14.5);
    expect(minutes).toBeLessThanOrEqual(15.5);
  });

  // Issuing a second token must not disarm the first: an operator who clicks
  // "refresh" while a colleague is mid-install would otherwise break the
  // install that is already running.
  it('does not invalidate a token that is still in flight', async () => {
    const nodeId = await makeNode();
    const first = await issue(nodeId);
    await issue(nodeId);
    expect((await redeem(first)).statusCode).toBe(200);
  });
});
