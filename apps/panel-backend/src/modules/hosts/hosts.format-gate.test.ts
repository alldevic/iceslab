// The host format gate, and the two lists that had to be one list.
//
// A host can be hidden from individual subscription formats
// (`disableForFormats[]`). The gate is one line in subscription.routes.ts: it
// compares the stored string to the `?format=` the client asked for. So the
// set of names the field ACCEPTS and the set the route SERVES have to be the
// same set, and until 2026-08-26 they were two hand-written lists with a
// comment between them saying "keep in sync".
//
// They had drifted in both directions, and both are quiet:
//
//   - `mieru-json` was in the host list and has never been a `?format=` value.
//     The field accepted it, the host was saved, and it was hidden from
//     nothing. The name came from a plan — `buildMieruProfileJson` exists, its
//     doc comment claimed the route returned it, and nothing has ever called
//     it outside its own test.
//   - `json`, `amneziavpn` and `xrayjson-array` are formats the route renders
//     separately, and no host could be hidden from any of them: the field
//     answered 400 on the name.
//
// The lists are now one exported constant, which makes a "do they match" check
// trivially true — so what is checked here is the pair of SCHEMAS, at the two
// doors an operator actually knocks on, plus the gate itself working for one
// of the names that could not be spelled before.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { SUBSCRIPTION_FORMATS } from '../subscription/subscription.format-names.js';
import { registerBindingsCacheBust } from '../subscription/subscription.bindings-cache.js';

let app: FastifyInstance;
let token: string;

// The squad-set binding cache is in-process and wired in index.ts, not
// buildApp: without this the second read of a subscription is served the
// answer from before the host edit, and the gate looks broken when it is not.
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

async function seed() {
  const profile = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/profiles',
        headers: auth(),
        payload: {
          name: 'gate-profile',
          protocol: 'xray',
          config: {
            security: 'reality',
            realityDest: 'www.microsoft.com:443',
            realityServerNames: ['www.microsoft.com'],
            realityPrivateKey: 'k'.repeat(43),
            realityPublicKey: 'p'.repeat(43),
            realityShortIds: ['0123abcd'],
            network: 'raw',
          },
        },
      })
    ).body,
  );
  const node = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/nodes',
        headers: auth(),
        payload: { name: 'gate-node', address: 'gate.example.com', protocol: 'xray' },
      })
    ).body,
  );
  const host = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/hosts',
        headers: auth(),
        payload: { profileId: profile.id, nodeId: node.id, port: 443, remark: 'Direct' },
      })
    ).body,
  );
  const squad = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/squads',
        headers: auth(),
        payload: { name: 'gate-squad', profileIds: [profile.id] },
      })
    ).body,
  );
  const user = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: auth(),
        payload: { username: 'gate_user', groupIds: [squad.id] },
      })
    ).body,
  );
  return { host, user };
}

describe('what the field accepts and what the route serves', () => {
  it('the list is a list at all', () => {
    // The control: an empty or one-item constant would make both loops below
    // pass by having nothing to disagree about.
    expect(SUBSCRIPTION_FORMATS.length).toBeGreaterThan(10);
  });

  it('every format the route serves can also be gated on a host', async () => {
    const { host } = await seed();
    for (const format of SUBSCRIPTION_FORMATS) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/hosts/${host.id}`,
        headers: auth(),
        payload: { disableForFormats: [format] },
      });
      expect(
        res.statusCode,
        `a host cannot be hidden from ?format=${format}: ${res.body}`,
      ).toBe(200);
    }
  });

  it('a name the route does not serve is refused rather than stored inert', async () => {
    const { host } = await seed();
    for (const notAFormat of ['mieru-json', 'v2rayng', '']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/hosts/${host.id}`,
        headers: auth(),
        payload: { disableForFormats: [notAFormat] },
      });
      expect(
        res.statusCode,
        `"${notAFormat}" was accepted; it hides the host from nothing and the operator is told it saved`,
      ).toBe(400);
    }
  });

  it('the route refuses the same name, so neither door invents a format', async () => {
    const { user } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=mieru-json`,
    });
    expect(res.statusCode).not.toBe(200);
  });
});

describe('the gate itself', () => {
  it('hides the host from the format it names and no other', async () => {
    // `json` is one of the three that could not be spelled at all before.
    const { host, user } = await seed();
    const body = async (format: string) =>
      (await app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}?format=${format}` }))
        .body;

    expect(await body('json'), 'fixture serves nothing to hide').toContain('Direct');

    const upd = await app.inject({
      method: 'PUT',
      url: `/api/hosts/${host.id}`,
      headers: auth(),
      payload: { disableForFormats: ['json'] },
    });
    expect(upd.statusCode).toBe(200);

    expect(await body('json')).not.toContain('Direct');
    // The neighbours are untouched: gating is per format, and a gate that took
    // the host out of everything would look identical in the one format the
    // operator was looking at.
    expect(Buffer.from(await body('plain'), 'base64').toString('utf8')).toContain('Direct');
  });
});
