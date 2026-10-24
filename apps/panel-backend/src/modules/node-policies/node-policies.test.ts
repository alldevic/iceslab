import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { NodeTransport } from '../nodes/nodes.transport.js';
import { pollNodeStatuses } from '../nodes/nodes.cron.js';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { resolvePolicyForNode } from './node-policies.service.js';
import { applyInboundsRequestForNode } from '../inbounds/inbounds.queue.js';
import { markShadowed, type PolicyRuleDto } from './node-policies.mapper.js';

/**
 * Э3 layer B on the panel side: the operator's policy, stored as a model and
 * turned into outbound names only when a node is pushed.
 *
 * The failure mode this module is built against is a rule that LOOKS applied
 * and is not: stored pointing at a way out that no longer exists, rendered onto
 * a node that cannot reach it, or sitting under a broader rule that eats it.
 * None of those announce themselves; the traffic simply goes somewhere else.
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

async function makeNode(opts: { warp?: boolean } = {}): Promise<string> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers: auth(),
    payload: { name: `pol-node-${seq}`, address: `pol-${seq}.test`, protocol: 'xray' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = JSON.parse(res.body).id as string;
  if (opts.warp) {
    await prisma.node.update({ where: { id }, data: { warpEnabled: true } });
  }
  return id;
}

interface RuleBody {
  enabled?: boolean;
  match?: Record<string, unknown>;
  action: { kind: string; directionId?: string | null };
}

async function createPolicy(rules: RuleBody[], expected = 201) {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/node-policies',
    headers: auth(),
    payload: { name: `policy-${seq}`, rules },
  });
  expect(res.statusCode, res.body).toBe(expected);
  return JSON.parse(res.body);
}

async function attach(nodeId: string, policyId: string | null, expected = 200) {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/nodes/${nodeId}`,
    headers: auth(),
    payload: { policyId },
  });
  expect(res.statusCode, res.body).toBe(expected);
  return JSON.parse(res.body);
}

/** A two-node cascade with one way out, which is what a cascade rule needs. */
async function cascadeWithDirection(entryId: string, exitId: string) {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/cascades',
    headers: auth(),
    payload: {
      name: `pol-cascade-${seq}`,
      enabled: true,
      positions: [{ position: 0, nodeIds: [entryId], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ nodeIds: [exitId], countryCode: 'NL' }],
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const cascadeId = JSON.parse(res.body).id as string;
  const direction = await prisma.cascadeDirection.findFirstOrThrow({
    where: { cascadeId },
    select: { id: true, tag: true },
  });
  return { cascadeId, direction };
}

describe('storing a policy', () => {
  it('keeps the order the operator wrote', async () => {
    const p = await createPolicy([
      { match: { domain: ['geosite:category-ads-all'] }, action: { kind: 'block' } },
      { match: { ip: ['geoip:ru'] }, action: { kind: 'direct' } },
    ]);
    expect(p.rules.map((r: PolicyRuleDto) => r.action.kind)).toEqual(['block', 'direct']);
    expect(p.rules.map((r: PolicyRuleDto) => r.position)).toEqual([0, 1]);
  });

  it('refuses a cascade rule with no direction, and a direction on any other kind', async () => {
    // Both pass a plain shape check and then mean something nobody asked for:
    // the first has nowhere to send traffic, the second is a leftover from
    // switching the action in the form.
    await createPolicy([{ action: { kind: 'cascade' } }], 400);
    await createPolicy(
      [{ action: { kind: 'direct', directionId: '00000000-0000-4000-8000-000000000000' } }],
      400,
    );
  });

  it('refuses a direction id that names nothing', async () => {
    await createPolicy(
      [{ action: { kind: 'cascade', directionId: '00000000-0000-4000-8000-000000000000' } }],
      400,
    );
  });

  it('stores the direction ID, never the outbound name', async () => {
    // The name is only true relative to one rendering. Stored, it would be
    // orphaned by the next cascade rebuild and the node would then refuse a
    // config over a rule nobody touched.
    const entry = await makeNode();
    const exit = await makeNode();
    const { direction } = await cascadeWithDirection(entry, exit);
    const p = await createPolicy([{ action: { kind: 'cascade', directionId: direction.id } }]);

    expect(p.rules[0].action.directionId).toBe(direction.id);
    const row = await prisma.nodePolicyRule.findFirstOrThrow({
      where: { policyId: p.id },
      select: { actionDirectionId: true },
    });
    expect(row.actionDirectionId).toBe(direction.id);
  });

  it('replaces the rule list wholesale on update', async () => {
    const p = await createPolicy([{ action: { kind: 'direct' } }]);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/node-policies/${p.id}`,
      headers: auth(),
      payload: { rules: [{ action: { kind: 'block' } }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).rules.map((r: PolicyRuleDto) => r.action.kind)).toEqual(['block']);
  });
});

describe('a policy has to fit the node it is attached to', () => {
  it('refuses a WARP rule on a node without WARP, at the save', async () => {
    // The core would refuse it too, minutes later, in a worker log attached to
    // a node rather than to the rule the operator just wrote.
    const nodeId = await makeNode();
    const p = await createPolicy([{ action: { kind: 'warp' } }]);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/nodes/${nodeId}`,
      headers: auth(),
      payload: { policyId: p.id },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('POLICY_DOES_NOT_FIT_NODE');
  });

  it('accepts the same policy on a node that has WARP', async () => {
    const nodeId = await makeNode({ warp: true });
    const p = await createPolicy([{ action: { kind: 'warp' } }]);
    await attach(nodeId, p.id);
  });

  it('refuses a cascade rule on a node that does not dial that direction', async () => {
    const entry = await makeNode();
    const exit = await makeNode();
    const outsider = await makeNode();
    const { direction } = await cascadeWithDirection(entry, exit);
    const p = await createPolicy([{ action: { kind: 'cascade', directionId: direction.id } }]);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/nodes/${outsider}`,
      headers: auth(),
      payload: { policyId: p.id },
    });
    expect(res.statusCode).toBe(409);
  });

  it('accepts it on the entry, which is the node that dials it', async () => {
    const entry = await makeNode();
    const exit = await makeNode();
    const { direction } = await cascadeWithDirection(entry, exit);
    const p = await createPolicy([{ action: { kind: 'cascade', directionId: direction.id } }]);
    await attach(entry, p.id);
  });
});

describe('matchers no engine reads are refused at the save (A-103)', () => {
  it('refuses an en-dash range, a port with a transport, a protocol name as a port, an address among domains, a domain among addresses, an unknown protocol', async () => {
    for (const match of [
      { port: '1000–2000' },
      { port: '443/tcp' },
      { port: 'http' },
      { port: '0' },
      { domain: ['geoip:ru'] },
      { domain: ['10.0.0.0/8'] },
      { ip: ['example.com'] },
      { ip: ['cidr:10.0.0.0/8'] },
      { protocol: ['ssh'] },
    ]) {
      const res = await createPolicy([{ match, action: { kind: 'block' } }], 400);
      expect(JSON.stringify(res), JSON.stringify(match)).toMatch(/not a|goes in the/);
    }
  });

  it('takes what both engines read', async () => {
    await createPolicy([
      { match: { port: '80,443,1000-2000' }, action: { kind: 'block' } },
      { match: { domain: ['geosite:category-ads-all', 'domain:example.com', 'example.org'] }, action: { kind: 'block' } },
      { match: { ip: ['geoip:ru', '10.0.0.0/8', '2001:db8::1'] }, action: { kind: 'direct' } },
      { match: { protocol: ['bittorrent'] }, action: { kind: 'block' } },
    ]);
  });

  it('a stored rule whose every matcher is unreadable is not sent, and does not become a rule on everything', async () => {
    const nodeId = await makeNode();
    const p = await createPolicy([
      { match: { port: '443' }, action: { kind: 'block' } },
      { match: { domain: ['ads.example'] }, action: { kind: 'block' } },
    ]);
    await attach(nodeId, p.id);
    // As a row from before the check holds it.
    const [first] = await prisma.nodePolicyRule.findMany({ where: { policyId: p.id }, orderBy: { position: 'asc' } });
    await prisma.nodePolicyRule.update({ where: { id: first!.id }, data: { matchPort: '1000–2000' } });
    const wire = await resolvePolicyForNode(nodeId);
    expect(wire?.rules).toEqual([{ match: { domain: ['ads.example'] }, action: { kind: 'block' } }]);
  });

  it('a stored rule that lost a whole kind of condition is not sent; one that lost part of a kind goes out narrower', async () => {
    const nodeId = await makeNode();
    const p = await createPolicy([
      { match: { domain: ['a.example'], port: '443' }, action: { kind: 'block' } },
      { match: { domain: ['b.example'], port: '443' }, action: { kind: 'block' } },
    ]);
    await attach(nodeId, p.id);
    const [first, second] = await prisma.nodePolicyRule.findMany({ where: { policyId: p.id }, orderBy: { position: 'asc' } });
    // "block, domain: [geoip:xx], port: 443": the domains gone, would block all of 443.
    await prisma.nodePolicyRule.update({ where: { id: first!.id }, data: { matchDomain: ['geoip:xx'] } });
    // Two domains, one unreadable: narrower, still sent.
    await prisma.nodePolicyRule.update({ where: { id: second!.id }, data: { matchDomain: ['geoip:xx', 'b.example'] } });
    const wire = await resolvePolicyForNode(nodeId);
    expect(wire?.rules).toEqual([{ match: { domain: ['b.example'], port: '443' }, action: { kind: 'block' } }]);
  });
});

describe('what the node is actually sent', () => {
  it('sends nothing at all for a node with no policy', async () => {
    // undefined, not an empty policy: the node renders byte-identically to
    // before the field existed, which is what makes the plumbing safe.
    const nodeId = await makeNode();
    expect(await resolvePolicyForNode(nodeId)).toBeUndefined();
  });

  it('turns a direction id into the outbound name at push time', async () => {
    const entry = await makeNode();
    const exit = await makeNode();
    const { direction } = await cascadeWithDirection(entry, exit);
    const p = await createPolicy([
      { match: { domain: ['youtube.com'] }, action: { kind: 'cascade', directionId: direction.id } },
    ]);
    await attach(entry, p.id);

    const wire = await resolvePolicyForNode(entry);
    expect(wire?.rules).toHaveLength(1);
    expect(wire!.rules[0]!.action).toEqual({
      kind: 'cascade',
      exit: `cascade-link-out-d${direction.tag}-0`,
    });
    expect(wire!.rules[0]!.match).toEqual({ domain: ['youtube.com'] });
  });

  it('names an outbound the push actually draws, on an entry under a chain and on a transit (A-108)', async () => {
    // The rule used to mirror the legacy drawing alone (cascade-link-out-d<t>-0),
    // which an entry under a chain does not get: its xray hands over to the
    // chain through cascade-link-out-chain-d<t>.
    const entry = await makeNode();
    const exit = await makeNode();
    const { direction } = await cascadeWithDirection(entry, exit);
    const p = await createPolicy([
      { match: { domain: ['youtube.com'] }, action: { kind: 'cascade', directionId: direction.id } },
    ]);
    await attach(entry, p.id);

    const req = await applyInboundsRequestForNode(entry);
    const exitTag = (req?.policy?.rules[0]?.action as { exit?: string } | undefined)?.exit;
    expect(exitTag).toBe(`cascade-link-out-chain-d${direction.tag}`);
    const handover = req?.chain?.userCore;
    expect(handover?.engine).toBe('xray');
    const outbounds = (handover as { fragments: { outbounds: { tag?: string }[] } }).fragments.outbounds;
    expect(outbounds.map((o) => o.tag)).toContain(exitTag);
  });

  it('says which rules the push leaves out on a node, and why (A-232)', async () => {
    const entry = await makeNode();
    const exit = await makeNode();
    const { cascadeId, direction } = await cascadeWithDirection(entry, exit);
    const p = await createPolicy([
      { match: { domain: ['youtube.com'] }, action: { kind: 'cascade', directionId: direction.id } },
      { match: { domain: ['ads.example'] }, action: { kind: 'block' } },
    ]);
    await attach(entry, p.id);
    const read = async () => {
      const res = await app.inject({ method: 'GET', url: `/api/nodes/${entry}/policy-drawing`, headers: auth() });
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body) as { policyId: string; drawing: string; notDrawn: { ruleId: string; reason: string }[] };
    };

    // An xray entry under a chain: the hand-over, every rule goes out.
    expect(await read()).toEqual({ policyId: p.id, drawing: 'handover', notDrawn: [], agent: null });

    // The same entry on hysteria: xray draws no way out, the cascade rule stays home.
    await prisma.cascadePosition.updateMany({ where: { cascadeId, position: 0 }, data: { entryProtocol: 'hysteria' } });
    const cascadeRule = p.rules.find((r: PolicyRuleDto) => r.action.kind === 'cascade');
    expect(await read()).toEqual({
      policyId: p.id,
      drawing: 'none',
      notDrawn: [{ ruleId: cascadeRule.id, reason: 'no-cascade-drawing' }],
      agent: null,
    });
  });

  it('a node in a cascade with no chain and no xray inbound reads "none", as the push sends nothing to it', async () => {
    // A hop-only cascade: no chain block, the legacy fragments only. The push
    // puts them on the node's xray inbound and has none to put them on.
    const entry = await makeNode();
    const exit = await makeNode();
    const res = await app.inject({
      method: 'POST',
      url: '/api/cascades',
      headers: auth(),
      payload: {
        name: 'hops-only',
        enabled: true,
        hops: [
          { nodeId: entry, position: 0, entryProtocol: 'xray', linkProtocol: 'vless' },
          { nodeId: exit, position: 1 },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const read = async () =>
      (JSON.parse((await app.inject({ method: 'GET', url: `/api/nodes/${entry}/policy-drawing`, headers: auth() })).body) as {
        drawing: string;
      }).drawing;

    const req = await applyInboundsRequestForNode(entry);
    expect(req?.chain).toBeUndefined();
    expect(req?.cascade).toBeUndefined();
    expect(await read()).toBe('none');

    // With an enabled xray inbound the push carries the fragments, and the read agrees.
    const profile = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: auth(),
      payload: {
        name: 'hops-vless',
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
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const bind = await app.inject({
      method: 'POST',
      url: '/api/bindings',
      headers: auth(),
      payload: { profileId: JSON.parse(profile.body).id, nodeId: entry, port: 443 },
    });
    expect(bind.statusCode, bind.body).toBe(201);
    expect((await applyInboundsRequestForNode(entry))?.cascade).toBeDefined();
    expect(await read()).toBe('legacy');
  });

  it("shows the node's own report beside the drawing sent: the poll keeps it, maps its exits to rules, and an old agent is null", async () => {
    const entry = await makeNode();
    const exit = await makeNode();
    const { direction } = await cascadeWithDirection(entry, exit);
    const p = await createPolicy([
      { match: { domain: ['youtube.com'] }, action: { kind: 'cascade', directionId: direction.id } },
    ]);
    await attach(entry, p.id);
    await prisma.node.updateMany({ data: { status: 'online' } });
    const read = async () =>
      JSON.parse((await app.inject({ method: 'GET', url: `/api/nodes/${entry}/policy-drawing`, headers: auth() })).body) as {
        drawing: string;
        agent: null | { drawing: string; notDrawn: { exit: string; direction: number; ruleIds: string[] }[]; renderedAt: string; observedAt: string };
      };

    // An agent that does not report: null, not "nothing left out".
    // The certificate end of an agent without the field is read off a
    // handshake (A-221); these nodes have no address to shake hands with.
    vi.spyOn(NodeTransport.prototype, 'presentedCert').mockRejectedValue(new Error('no node here'));
    const health = vi.spyOn(NodeTransport.prototype, 'healthcheck');
    health.mockResolvedValue({ status: 'ok', cores: [] } as never);
    await pollNodeStatuses();
    expect((await read()).agent).toBeNull();

    // The chain refused on the node: it drew the legacy legs and left the rule out.
    const exitTag = `cascade-link-out-chain-d${direction.tag}`;
    health.mockResolvedValue({
      status: 'ok',
      cores: [],
      policy: { drawing: 'legacy', notDrawn: [{ exit: exitTag, direction: direction.tag }, { exit: 'cascade-link-out-chain-d99', direction: 99 }], renderedAt: '2026-10-24T10:00:00Z' },
    } as never);
    await pollNodeStatuses();
    const got = await read();
    expect(got.drawing).toBe('handover');
    const rule = p.rules[0] as PolicyRuleDto;
    expect(got.agent).toMatchObject({
      drawing: 'legacy',
      renderedAt: '2026-10-24T10:00:00Z',
      notDrawn: [
        { exit: exitTag, direction: direction.tag, ruleIds: [rule.id] },
        // A way out no rule of the current policy names: kept, not lost.
        { exit: 'cascade-link-out-chain-d99', direction: 99, ruleIds: [] },
      ],
    });
    expect(Number.isFinite(Date.parse(got.agent!.observedAt))).toBe(true);

    // A poll without the field keeps the fact.
    health.mockResolvedValue({ status: 'ok', cores: [] } as never);
    await pollNodeStatuses();
    expect((await read()).agent?.drawing).toBe('legacy');
    vi.restoreAllMocks();
  });

  it('drops a cascade rule where the push draws no way out in xray', async () => {
    const entry = await makeNode();
    const exit = await makeNode();
    const { direction } = await cascadeWithDirection(entry, exit);
    const p = await createPolicy([
      { match: { domain: ['youtube.com'] }, action: { kind: 'cascade', directionId: direction.id } },
      { match: { domain: ['ads.example'] }, action: { kind: 'block' } },
    ]);
    await attach(entry, p.id);
    const wire = await resolvePolicyForNode(entry, 'none');
    expect(wire?.rules.map((r) => r.action.kind)).toEqual(['block']);
  });

  it('leaves a disabled rule out of the push', async () => {
    const nodeId = await makeNode();
    const p = await createPolicy([
      { enabled: false, action: { kind: 'block' } },
      { action: { kind: 'direct' } },
    ]);
    await attach(nodeId, p.id);

    const wire = await resolvePolicyForNode(nodeId);
    expect(wire?.rules.map((r) => r.action.kind)).toEqual(['direct']);
  });

  it('omits empty match fields instead of sending empty arrays', async () => {
    const nodeId = await makeNode();
    const p = await createPolicy([{ match: { ip: ['geoip:ru'] }, action: { kind: 'direct' } }]);
    await attach(nodeId, p.id);

    const wire = await resolvePolicyForNode(nodeId);
    expect(wire!.rules[0]!.match).toEqual({ ip: ['geoip:ru'] });
  });

  it('detaching leaves the node with no policy, not with the last one', async () => {
    const nodeId = await makeNode();
    const p = await createPolicy([{ action: { kind: 'direct' } }]);
    await attach(nodeId, p.id);
    expect(await resolvePolicyForNode(nodeId)).toBeDefined();

    await attach(nodeId, null);
    expect(await resolvePolicyForNode(nodeId)).toBeUndefined();
  });

  it('deleting the policy detaches the nodes running it', async () => {
    const nodeId = await makeNode();
    const p = await createPolicy([{ action: { kind: 'direct' } }]);
    await attach(nodeId, p.id);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/node-policies/${p.id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    expect(await resolvePolicyForNode(nodeId)).toBeUndefined();
  });
});

describe('a cascade direction a policy routes through', () => {
  it('survives an unrelated edit of the cascade as the SAME row', async () => {
    // The whole design rests on this. Before Э3 the save deleted every
    // direction and recreated it, which nothing noticed while the TAG was the
    // only identity in use; with a rule holding the id, that would orphan the
    // rule on every edit.
    const entry = await makeNode();
    const exit = await makeNode();
    const { cascadeId, direction } = await cascadeWithDirection(entry, exit);
    const p = await createPolicy([{ action: { kind: 'cascade', directionId: direction.id } }]);
    await attach(entry, p.id);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/cascades/${cascadeId}`,
      headers: auth(),
      payload: {
        positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
        directions: [{ id: direction.id, nodeIds: [exit], countryCode: 'DE' }],
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await prisma.cascadeDirection.findUnique({
      where: { id: direction.id },
      select: { id: true, countryCode: true },
    });
    expect(after?.id).toBe(direction.id);
    expect(after?.countryCode).toBe('DE');
    const rule = await prisma.nodePolicyRule.findFirstOrThrow({ where: { policyId: p.id } });
    expect(rule.actionDirectionId).toBe(direction.id);
  });

  it('cannot be removed while the policy still routes through it', async () => {
    // Refused at the save, naming the policy. Dropping the rule instead would
    // change what a node does with traffic as a side effect of editing a
    // cascade, and nothing would say so.
    const entry = await makeNode();
    const exit = await makeNode();
    const { cascadeId, direction } = await cascadeWithDirection(entry, exit);
    const p = await createPolicy([{ action: { kind: 'cascade', directionId: direction.id } }]);
    await attach(entry, p.id);

    const second = await makeNode();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/cascades/${cascadeId}`,
      headers: auth(),
      payload: {
        positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
        directions: [{ nodeIds: [second], countryCode: 'SE' }],
      },
    });
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('DIRECTION_IN_USE_BY_POLICY');
    // Names the policy, so the panel can link straight to it rather than
    // saying "something uses this".
    expect(body.policies).toContain(p.name);
    // The rule is still there, pointing at a direction that still exists.
    const rule = await prisma.nodePolicyRule.findFirstOrThrow({ where: { policyId: p.id } });
    expect(rule.actionDirectionId).toBe(direction.id);
  });
});

describe('a rule that can never fire', () => {
  const rule = (
    id: string,
    position: number,
    match: Partial<PolicyRuleDto['match']>,
  ): PolicyRuleDto => ({
    id,
    position,
    enabled: true,
    match: { domain: [], ip: [], port: null, protocol: [], network: null, ...match },
    action: { kind: 'direct', directionId: null },
  });

  it('is marked when an earlier rule already matches everything it matches', () => {
    const rules = [
      rule('a', 0, { domain: ['geosite:cn', 'geosite:ru'] }),
      rule('b', 1, { domain: ['geosite:ru'] }),
    ];
    markShadowed(rules);
    expect(rules[1]!.shadowedBy?.id).toBe('a');
  });

  it('a catch-all swallows everything after it', () => {
    const rules = [rule('a', 0, {}), rule('b', 1, { ip: ['geoip:ru'] })];
    markShadowed(rules);
    expect(rules[1]!.shadowedBy?.id).toBe('a');
  });

  it('does not accuse a rule that is broader than the one above it', () => {
    // The direction of error matters: a false "this never runs" makes an
    // operator delete a rule that was doing its job.
    const rules = [rule('a', 0, { domain: ['geosite:ru'] }), rule('b', 1, {})];
    markShadowed(rules);
    expect(rules[1]!.shadowedBy).toBeNull();
  });

  it('does not accuse across different axes', () => {
    const rules = [rule('a', 0, { domain: ['x.com'] }), rule('b', 1, { ip: ['geoip:ru'] })];
    markShadowed(rules);
    expect(rules[1]!.shadowedBy).toBeNull();
  });

  it('tcp,udp swallows a tcp-only rule, and not the other way round', () => {
    const wide = [rule('a', 0, { network: 'tcp,udp' }), rule('b', 1, { network: 'tcp' })];
    markShadowed(wide);
    expect(wide[1]!.shadowedBy?.id).toBe('a');

    const narrow = [rule('a', 0, { network: 'tcp' }), rule('b', 1, { network: 'tcp,udp' })];
    markShadowed(narrow);
    expect(narrow[1]!.shadowedBy).toBeNull();
  });

  it('a disabled rule neither shadows nor is reported as shadowed', () => {
    const rules = [rule('a', 0, {}), rule('b', 1, { ip: ['geoip:ru'] })];
    rules[0]!.enabled = false;
    markShadowed(rules);
    expect(rules[1]!.shadowedBy).toBeNull();
  });

  it('travels on the DTO, so the screen can show it without asking again', async () => {
    const p = await createPolicy([
      { action: { kind: 'direct' } },
      { match: { ip: ['geoip:ru'] }, action: { kind: 'block' } },
    ]);
    expect(p.rules[0].shadowedBy).toBeNull();
    expect(p.rules[1].shadowedBy?.position).toBe(0);
  });
});
