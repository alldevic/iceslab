import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import contract from './contracts/minishop-contract.json' with { type: 'json' };

/**
 * The facade against the minishop's own registry of outbound calls.
 *
 * The shop ships `panel_api_contracts.py`, which it calls "the source of truth
 * for every outbound Remnawave request made by Mini Shop" and uses to fail its
 * own CI when a call is added without a support decision. So the set of routes
 * we have to serve is a fact we can read, not a reading of Python that has to
 * be redone by hand every release - and this file turns it into a gate.
 *
 * `contracts/minishop-contract.json` is a pinned capture (see the `source`
 * block in it and scripts/refresh-minishop-contract.mjs). Pinned rather than
 * fetched, because a gate that reaches into another repository at test time
 * passes or fails on whatever that repository happens to be today and stops
 * being a statement about our code.
 *
 * What it checks is ROUTING, not behaviour: for each operation the shop can
 * make under the generation we declare, does a route exist at all? That is the
 * question a passing unit test of our own handlers cannot answer, because a
 * handler nobody can reach still has passing tests.
 */

type Op = {
  operation: string;
  method: string;
  path: string;
  generations: string[];
  mutation: boolean;
};
const OPS = (contract as { operations: Op[] }).operations;
const RW3 = 'rw3-numeric-user-id';

/**
 * The four operations we deliberately do NOT serve, and the reason that is
 * safe: the shop classifies their 404 as "this panel build has no such route",
 * marks the capability absent and stops asking. Any other 404 shape - one
 * carrying an errorCode - reads as "route exists, entity missing", and the
 * shop would retry the doomed call forever. See UNSERVED_IS_CLASSIFIABLE below,
 * which is the assertion that keeps this list honest.
 */
const DELIBERATELY_UNSERVED = new Set([
  'users.bulk-update-squads',
  'users.connections.drop-v3',
  'bandwidth.nodes-users',
  'bandwidth.nodes-usage',
]);

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
const PREFIX = 'rw';
const token = `icp_contract_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_PREFIX'] = PREFIX;
  const [{ buildApp }, prismaMod] = await Promise.all([
    import('../../app.js'),
    import('../../prisma.js'),
  ]);
  prisma = prismaMod.prisma;
  app = await buildApp();
  await app.ready();
  await prisma.apiToken.create({ data: { name: 'contract', tokenHash: sha(token), scopes: [] } });
});

afterAll(async () => {
  await prisma.apiToken.deleteMany({ where: { tokenHash: sha(token) } });
  await app.close();
});

/**
 * Placeholders chosen so nothing can be found and nothing can be written: every
 * probe below is a real request against the running app, and a mutation that
 * matched a real row would be a test that changes the database to check a
 * routing table.
 */
const ABSENT = {
  '{userRef}': '999999999',
  '{telegramId}': '999999999',
  '{username}': 'contract-probe-absent',
  '{email}': 'absent@example.invalid',
  '{shortUuid}': 'contractprobeabsent',
  '{uuid}': '00000000-0000-4000-8000-0000000000ff',
  '{nodeUuid}': '00000000-0000-4000-8000-0000000000ff',
};

/** `/users/{ref}/actions/{enable|disable}` is one contract row for two routes. */
function expandAlternations(path: string): string[] {
  const m = /\{([a-z-]+(?:\|[a-z-]+)+)\}/.exec(path);
  if (!m) return [path];
  return m[1].split('|').flatMap((choice) => expandAlternations(path.replace(m[0], choice)));
}

function concretePaths(path: string): string[] {
  return expandAlternations(path).map((p) => {
    let out = p;
    for (const [ph, value] of Object.entries(ABSENT)) out = out.replaceAll(ph, value);
    return out;
  });
}

/**
 * The shop's own predicate for "this panel build does not expose the route",
 * transcribed from panel_api_responses.py `_is_missing_endpoint_response`:
 * 404, no errorCode in the body, and a message that reads like a router miss.
 * Everything the facade decides about which capabilities the shop believes it
 * has flows through exactly this function, so it is reproduced rather than
 * approximated.
 */
function readsAsMissingRoute(status: number, body: string): boolean {
  if (status !== 404) return false;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (parsed['errorCode']) return false;
  const message = String(parsed['message'] ?? '').toLowerCase();
  return (
    message.includes('cannot post') || message.includes('cannot get') || message.includes('not found')
  );
}

async function probe(op: Op, path: string) {
  const res = await app.inject({
    method: op.method as 'GET',
    url: `/${PREFIX}/api${path}`,
    headers: { authorization: `Bearer ${token}` },
    ...(op.method === 'GET' || op.method === 'DELETE' ? {} : { payload: {} }),
  });
  return { status: res.statusCode, body: res.body };
}

const rw3Ops = OPS.filter((o) => o.generations.includes(RW3));

describe('the capture itself', () => {
  it('is the registry, not a hand-written list', () => {
    // If the shop restructures the registry and the refresh script silently
    // produces an empty or truncated file, every assertion below passes by
    // having nothing to check.
    expect(OPS.length).toBeGreaterThanOrEqual(40);
    expect(rw3Ops.length).toBeGreaterThanOrEqual(30);
    const src = JSON.parse(
      readFileSync(new URL('./contracts/minishop-contract.json', import.meta.url), 'utf8'),
    ) as { source: { describe: string; commit: string } };
    expect(src.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(src.source.describe).toBeTruthy();
  });

  it('every operation the shop declares is either served or listed as unserved', () => {
    // Names, not routes: a renamed operation in a new shop release shows up here
    // as an unknown name rather than as a mysteriously missing route.
    const unknown = [...DELIBERATELY_UNSERVED].filter(
      (name) => !OPS.some((o) => o.operation === name),
    );
    expect(unknown, 'the unserved list names an operation the shop no longer has').toEqual([]);
  });
});

describe('every rw3 operation the shop can call reaches a route', () => {
  for (const op of rw3Ops.filter((o) => !DELIBERATELY_UNSERVED.has(o.operation))) {
    it(`${op.method} ${op.path} (${op.operation})`, async () => {
      for (const path of concretePaths(op.path)) {
        const { status, body } = await probe(op, path);
        expect(
          readsAsMissingRoute(status, body),
          `${op.method} ${path} -> ${status} ${body.slice(0, 200)}\n` +
            `The shop would read that as "this panel has no such route" and stop calling it.`,
        ).toBe(false);
      }
    });
  }
});

describe('the four unserved operations are unserved in the one way that is safe', () => {
  for (const op of rw3Ops.filter((o) => DELIBERATELY_UNSERVED.has(o.operation))) {
    it(`${op.method} ${op.path} answers a classifiable 404`, async () => {
      for (const path of concretePaths(op.path)) {
        const { status, body } = await probe(op, path);
        expect(
          readsAsMissingRoute(status, body),
          `${op.method} ${path} -> ${status} ${body.slice(0, 200)}\n` +
            `Not serving a route is only safe while the shop can TELL it is absent. ` +
            `A 404 carrying an errorCode reads as "entity missing" and the shop retries forever.`,
        ).toBe(true);
      }
    });
  }
});

describe('the webhook events this facade sends', () => {
  /**
   * The containment goes ONE way, and it is worth being precise about which.
   *
   * Not "the facade sends everything the shop can handle" - the shop handles
   * events no panel is obliged to send (`user.expiration`,
   * `user.expired_24_hours_ago`), and demanding them would be inventing a
   * requirement.
   *
   * The direction that matters is the reverse: everything the facade sends must
   * be something the shop ACTS on. Its dispatcher drops any other name without
   * a word and still answers 200, so an invented or mistyped event is a webhook
   * we deliver, log as delivered, and nobody acts on. For the 24h stage - the
   * shop's only auto-renew charge trigger - that is a subscription that lapses
   * with a working saved card and a green log on both sides.
   */
  it('every event the facade can send is one the shop acts on', async () => {
    const { REMNAWAVE_EMITTED_EVENTS } = await import('./remnawave.webhook.js');
    const actionable = (contract as { actionableEvents: string[] }).actionableEvents;
    expect(actionable.length, 'the captured set is empty - the refresh script read nothing')
      .toBeGreaterThan(0);
    for (const event of REMNAWAVE_EMITTED_EVENTS) {
      expect(actionable, `the shop would silently drop: ${event}`).toContain(event);
    }
  });

  it('the shop still acts on the stage the auto-renew charge hangs on', async () => {
    // Named on its own because it is not interchangeable with the other two:
    // 72h and 48h are notifications, 24h is the charge. If a shop release ever
    // drops it from the set, the containment test above still passes for the
    // other three and this one says what actually broke.
    const actionable = (contract as { actionableEvents: string[] }).actionableEvents;
    expect(actionable).toContain('user.expires_in_24_hours');
  });
});
