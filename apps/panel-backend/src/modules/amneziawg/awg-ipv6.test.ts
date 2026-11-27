import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddUserRequest, AmneziawgInboundCfg, CoreStatus, NodeCores, NodeIPv6 } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { WG_TEST_PRIVATE_KEY, WG_TEST_PUBLIC_KEY } from '../../../tests/helpers/wg-keys.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';
import { observedCores } from '../nodes/nodes.cron.js';
import { applyInboundsForNode, fetchEnabledInbounds } from '../inbounds/inbounds.queue.js';
import { syncAddUser } from '../users/users.queue.js';
import { awgInterfacesInChain } from '../cascades/cascade.service.js';
import { interfaceCarriesIpv6, NO_TUNNEL_IPV6, nodeAgentCarriesTunnelIpv6, tunnelIpv6OfNode } from './awg-ipv6.js';
import { ipv4OfIpv6, ipv6OfIpv4 } from './amneziawg.subnet.js';

/**
 * 18.9: where the tunnel carries IPv6. The table of the one function, then the
 * push (the interface's `subnet6` and the peers' IPv6) and the client configs
 * of the same node, against the same facts.
 */
const S6_1 = 'fd12:3456:789a:1::/64';
const S6_3 = 'fd12:3456:789a:3::/64';
const S6_W = 'fd12:3456:789a:7::/64';

const ipv6Facts = (over: Partial<NodeIPv6> = {}): NodeIPv6 => ({ stack: true, global: true, addresses: ['2001:db8::1'], ...over });
const awgRow = (over: Partial<CoreStatus> = {}): CoreStatus => ({
  name: 'amneziawg',
  engine: 'amneziawg',
  running: true,
  installed: true,
  awgProtocol: 3,
  awgGenerations: [1, 3],
  awgIpv6: true,
  ...over,
});
const coresOf = (rows: CoreStatus[], ipv6?: NodeIPv6): NodeCores =>
  observedCores(rows, new Date().toISOString(), undefined, undefined, undefined, ipv6) as unknown as NodeCores;

describe('interfaceCarriesIpv6: the table of conditions', () => {
  const none = { one: false, three: false };
  const full = { cores: coresOf([awgRow()], ipv6Facts()), ipv6Mode: 'auto' as const };

  it('all facts, mode not off, no chain: every interface carries it', () => {
    for (const i of ['one', 'three', 'wg'] as const) expect(interfaceCarriesIpv6(full, i, none), i).toBe(true);
  });

  it.each([
    ['no awgIpv6 fact', { cores: coresOf([awgRow({ awgIpv6: undefined })], ipv6Facts()), ipv6Mode: 'auto' as const }],
    ['awgIpv6 false', { cores: coresOf([awgRow({ awgIpv6: false })], ipv6Facts()), ipv6Mode: 'auto' as const }],
    ['no global address', { cores: coresOf([awgRow()], ipv6Facts({ global: false })), ipv6Mode: 'auto' as const }],
    ['no ipv6 block at all', { cores: coresOf([awgRow()]), ipv6Mode: 'auto' as const }],
    ['never polled', { cores: null, ipv6Mode: 'auto' as const }],
    ['mode off', { cores: coresOf([awgRow()], ipv6Facts()), ipv6Mode: 'off' as const }],
    ['no amneziawg core row', { cores: coresOf([{ name: 'xray', engine: 'xray', running: true, installed: true }], ipv6Facts()), ipv6Mode: 'auto' as const }],
  ])('%s: no interface', (_name, facts) => {
    for (const i of ['one', 'three', 'wg'] as const) expect(interfaceCarriesIpv6(facts, i, none), i).toBe(false);
  });

  it('mode on does not stand in for the agent fact or the address', () => {
    expect(nodeAgentCarriesTunnelIpv6({ cores: coresOf([awgRow({ awgIpv6: false })], ipv6Facts()), ipv6Mode: 'on' })).toBe(false);
    expect(nodeAgentCarriesTunnelIpv6({ cores: coresOf([awgRow()], ipv6Facts({ global: false })), ipv6Mode: 'on' })).toBe(false);
    expect(nodeAgentCarriesTunnelIpv6({ cores: coresOf([awgRow()], ipv6Facts()), ipv6Mode: 'on' })).toBe(true);
  });

  it('an interface given to a cascade chain does not carry it, the other one does', () => {
    expect(interfaceCarriesIpv6(full, 'one', { one: true, three: false })).toBe(false);
    expect(interfaceCarriesIpv6(full, 'three', { one: true, three: false })).toBe(true);
    expect(interfaceCarriesIpv6(full, 'three', { one: false, three: true })).toBe(false);
    expect(interfaceCarriesIpv6(full, 'one', { one: false, three: true })).toBe(true);
    // Plain WireGuard is never a chain entry.
    expect(interfaceCarriesIpv6(full, 'wg', { one: true, three: true })).toBe(true);
  });
});

let app: FastifyInstance;
let token: string;
let seq = 0;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  seq = 0;
  vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });
async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return JSON.parse(res.body);
}

const awgCfg = (subnet: string, subnet6?: string) => ({
  serverPrivateKey: WG_TEST_PRIVATE_KEY,
  serverPublicKey: WG_TEST_PUBLIC_KEY,
  subnet,
  ...(subnet6 ? { subnet6 } : {}),
  obfuscation: {},
});
const wgCfg = (subnet: string, subnet6?: string) => ({
  serverPrivateKey: WG_TEST_PRIVATE_KEY,
  serverPublicKey: WG_TEST_PUBLIC_KEY,
  subnet,
  ...(subnet6 ? { subnet6 } : {}),
});

async function setCores(nodeId: string, rows: CoreStatus[], ipv6?: NodeIPv6, mode?: 'auto' | 'on' | 'off') {
  await prisma.node.update({
    where: { id: nodeId },
    data: { cores: coresOf(rows, ipv6) as unknown as object, ...(mode ? { ipv6Mode: mode } : {}) },
  });
}

async function makeNode(name = 'v6'): Promise<string> {
  seq += 1;
  const n = await post('/api/nodes', { name: `${name}-${seq}`, address: `${name}-${seq}.test`, protocol: 'xray' });
  await prisma.node.update({ where: { id: n.id }, data: { lastInboundSyncAt: new Date() } });
  return n.id as string;
}

async function profile(protocol: string, config: unknown, extra: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  return (await post('/api/profiles', { name: `v6-p-${seq}`, protocol, config, ...extra })).id as string;
}

async function host(profileId: string, nodeId: string, port: number): Promise<string> {
  return (await post('/api/hosts', { profileId, nodeId, port, remark: 'Default' })).bindingId as string;
}

/** A node with the 1.x, the 3.1 and the plain interface; `subnet6` on each of the three profiles. */
async function tunnelNode(opts: { v6?: boolean } = {}) {
  const v6 = opts.v6 ?? true;
  const n = await makeNode();
  const one = await profile('amneziawg', awgCfg('10.66.66.0/24', v6 ? S6_1 : undefined));
  const three = await profile('amneziawg', awgCfg('10.67.67.0/24', v6 ? S6_3 : undefined), { awgProtocol: 3 });
  const plain = await profile('wireguard', wgCfg('10.77.77.0/24', v6 ? S6_W : undefined));
  await setCores(n, [awgRow(), { name: 'wireguard', engine: 'wireguard', running: true, installed: true }], ipv6Facts());
  await host(one, n, 51820);
  await host(three, n, 51830);
  await host(plain, n, 51840);
  const sq = await post('/api/squads', { name: `v6-sq-${seq}`, profileIds: [one, three, plain] });
  return { n, sq, one, three, plain };
}

async function user(name: string, groupIds: string[]): Promise<string> {
  return (await post('/api/users', { username: name, groupIds })).id as string;
}

function capture() {
  const sent: { inbounds: { protocol: string; port: number; config: unknown }[] }[] = [];
  const added: AddUserRequest[] = [];
  vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockImplementation(async (req) => {
    sent.push(req as never);
    return { ok: true, applied: 3, skipped: 0 } as never;
  });
  vi.spyOn(NodeTransport.prototype, 'addUsers').mockImplementation(async (batch) => {
    added.push(...batch.users);
    return { results: batch.users.map((u) => ({ userId: u.userId, ok: true })) };
  });
  vi.spyOn(NodeTransport.prototype, 'addUser').mockImplementation(async (req) => {
    added.push(req);
    return { ok: true };
  });
  vi.spyOn(NodeTransport.prototype, 'removeUser').mockResolvedValue({ ok: true });
  return { sent, added };
}

const cfgAt = (inbounds: { port: number; config: unknown }[], port: number) =>
  inbounds.find((i) => i.port === port)!.config as AmneziawgInboundCfg;

describe('the push of a profile with subnet6', () => {
  it('a node with the facts gets subnet6 on each interface, the old fields as they were', async () => {
    const { n } = await tunnelNode();
    const inbounds = await fetchEnabledInbounds(n);
    expect(cfgAt(inbounds, 51820).subnet6).toBe(S6_1);
    expect(cfgAt(inbounds, 51830).subnet6).toBe(S6_3);
    expect(cfgAt(inbounds, 51840).subnet6).toBe(S6_W);
    // The IPv4 half of the request is untouched.
    expect(cfgAt(inbounds, 51820).subnet).toBe('10.66.66.0/24');
    expect(cfgAt(inbounds, 51820).listenPort).toBe(51820);
  });

  it('a node without the awgIpv6 fact gets the request it got before, byte for byte', async () => {
    const withV6 = await tunnelNode();
    await setCores(withV6.n, [awgRow({ awgIpv6: undefined }), { name: 'wireguard', engine: 'wireguard', running: true, installed: true }], ipv6Facts());
    const withoutProfileV6 = await tunnelNode({ v6: false });
    const a = await fetchEnabledInbounds(withV6.n);
    const b = await fetchEnabledInbounds(withoutProfileV6.n);
    for (const port of [51820, 51830, 51840]) {
      expect(JSON.stringify(cfgAt(a, port))).not.toContain('subnet6');
      // Same config, key for key, as the node whose profiles never had the field
      // (the binding id differs, nothing else does).
      const { inboundId: ia, ...ra } = cfgAt(a, port) as unknown as Record<string, unknown>;
      const { inboundId: ib, ...rb } = cfgAt(b, port) as unknown as Record<string, unknown>;
      expect(ia).not.toBe(ib);
      expect(Object.keys(ra)).toEqual(Object.keys(rb));
    }
  });

  it('mode off, and a host with no global address, take it back out', async () => {
    const { n } = await tunnelNode();
    await setCores(n, [awgRow(), { name: 'wireguard', engine: 'wireguard', running: true, installed: true }], ipv6Facts(), 'off');
    expect(JSON.stringify(await fetchEnabledInbounds(n))).not.toContain('subnet6');
    await setCores(n, [awgRow(), { name: 'wireguard', engine: 'wireguard', running: true, installed: true }], ipv6Facts({ global: false }), 'auto');
    expect(JSON.stringify(await fetchEnabledInbounds(n))).not.toContain('subnet6');
    await setCores(n, [awgRow(), { name: 'wireguard', engine: 'wireguard', running: true, installed: true }], ipv6Facts(), 'auto');
    expect(JSON.stringify(await fetchEnabledInbounds(n))).toContain(S6_1);
  });
});

describe('the peers of a profile with subnet6', () => {
  it('carry the IPv6 on each interface that has it, derived from the IPv4 address', async () => {
    const { n, sq } = await tunnelNode();
    const a = await user('v6_peers', [sq.id]);
    const { added } = capture();
    await applyInboundsForNode(n);
    const c = added.find((r) => r.userId === a)!.credentials;
    const peers = c.amneziawgPeers!;
    expect(peers).toHaveLength(3);
    for (const p of peers) {
      expect(p.allowedIp6).toBe(ipv6OfIpv4(S6_1, p.allowedIp!));
      expect(p.allowedIp3v6).toBe(ipv6OfIpv4(S6_3, p.allowedIp3!));
      expect(p.wireguardAllowedIp6).toBe(ipv6OfIpv4(S6_W, p.wireguardAllowedIp!));
      expect(ipv4OfIpv6(S6_1, p.allowedIp6!)).toBe(p.allowedIp);
    }
    // Device 1's, for the single fields.
    expect(c.amneziawgAllowedIp6).toBe(peers[0]!.allowedIp6);
    expect(c.amneziawgAllowedIp3v6).toBe(peers[0]!.allowedIp3v6);
    expect(c.wireguardAllowedIp6).toBe(peers[0]!.wireguardAllowedIp6);
    // The IPv4 addresses are the ones the user had: nothing moved.
    expect(c.amneziawgAllowedIp).toBe(peers[0]!.allowedIp);
  });

  it('carry nothing of it on a node without the fact, and the rest of the record is the same', async () => {
    const withV6 = await tunnelNode();
    const without = await tunnelNode({ v6: false });
    await setCores(withV6.n, [awgRow({ awgIpv6: undefined }), { name: 'wireguard', engine: 'wireguard', running: true, installed: true }], ipv6Facts());
    const a = await user('v6_none', [withV6.sq.id, without.sq.id]);
    const { added } = capture();
    await applyInboundsForNode(withV6.n);
    const c = added.find((r) => r.userId === a)!.credentials;
    expect(JSON.stringify(c)).not.toMatch(/Ip3?6|AllowedIp6|AllowedIp3v6/);
    expect(JSON.stringify(c)).not.toContain('fd12');
  });

  it('are the same when one user is rolled out (syncAddUser) as when the node is pushed', async () => {
    const { n, sq } = await tunnelNode();
    const a = await user('v6_roll', [sq.id]);
    const pushed = capture();
    await applyInboundsForNode(n);
    const viaPush = pushed.added.find((r) => r.userId === a)!.credentials.amneziawgPeers;
    vi.restoreAllMocks();
    vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
    const rolled = capture();
    await syncAddUser(a);
    expect(rolled.added.find((r) => r.userId === a)!.credentials.amneziawgPeers).toEqual(viaPush);
    expect(viaPush![0]!.allowedIp6).toBeTruthy();
  });
});

describe('the client configs of a node with the facts', () => {
  const confOf = async (userId: string, query = ''): Promise<string> => {
    const t = (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { subscriptionToken: true } })).subscriptionToken;
    const res = await app.inject({ method: 'GET', url: `/sub/${t}?format=wgconf&${query}`, remoteAddress: `10.79.1.${++seq}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.body;
  };
  const line = (conf: string, name: string) => new RegExp(`^${name} = (.+)$`, 'm').exec(conf)?.[1];

  it('Address carries both addresses, the IPv6 the peer holds, and AllowedIPs ::/0, for 1.x, 3.1 and plain', async () => {
    const { n, sq } = await tunnelNode();
    const a = await user('v6_conf', [sq.id]);
    const { added } = capture();
    await applyInboundsForNode(n);
    const p = added.find((r) => r.userId === a)!.credentials.amneziawgPeers![0]!;
    const one = await confOf(a);
    expect(line(one, 'Address')).toBe(`${p.allowedIp}/32, ${p.allowedIp6}/128`);
    expect(line(one, 'AllowedIPs')).toBe('0.0.0.0/0, ::/0');
    const wg = await confOf(a, 'protocols=wireguard');
    expect(line(wg, 'Address')).toBe(`${p.wireguardAllowedIp}/32, ${p.wireguardAllowedIp6}/128`);
    expect(line(wg, 'AllowedIPs')).toBe('0.0.0.0/0, ::/0');
    const three = await confOf(a, 'node=' + encodeURIComponent((await prisma.node.findUniqueOrThrow({ where: { id: n } })).name + ' · 3.1'));
    expect(line(three, 'Address')).toBe(`${p.allowedIp3}/32, ${p.allowedIp3v6}/128`);
  });

  it('a node without the awgIpv6 fact: IPv4 Address only, as before', async () => {
    const { n, sq } = await tunnelNode();
    await setCores(n, [awgRow({ awgIpv6: false }), { name: 'wireguard', engine: 'wireguard', running: true, installed: true }], ipv6Facts());
    const a = await user('v6_conf_no', [sq.id]);
    for (const q of ['', 'protocols=wireguard']) {
      const conf = await confOf(a, q);
      expect(line(conf, 'Address')).toMatch(/^10\.\d+\.\d+\.\d+\/32$/);
      expect(conf).not.toContain('fd12');
    }
  });

  it('mode off takes the second address out at once, with no poll in between', async () => {
    const { n, sq } = await tunnelNode();
    const a = await user('v6_conf_off', [sq.id]);
    expect(line(await confOf(a), 'Address')).toContain(',');
    await prisma.node.update({ where: { id: n }, data: { ipv6Mode: 'off' } });
    expect(line(await confOf(a), 'Address')).not.toContain(',');
  });

  it('a profile without subnet6 on a node with the facts: the conf is the old one', async () => {
    const { n, sq } = await tunnelNode({ v6: false });
    const a = await user('v6_conf_plain', [sq.id]);
    const conf = await confOf(a);
    expect(line(conf, 'Address')).toMatch(/^10\.66\.66\.\d+\/32$/);
    await expect(tunnelIpv6OfNode(n)).resolves.toEqual({ one: true, three: true, wg: true });
  });
});

describe('an interface given to a cascade chain (until 18.12)', () => {
  async function cascadeOnto(entry: string) {
    seq += 1;
    const exit = await makeNode('nl-exit');
    await post('/api/cascades', {
      name: `ru-out-${seq}`,
      enabled: true,
      autoProfile: false,
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'amneziawg', linkProtocol: 'vless' }],
      directions: [{ countryCode: 'NL', nodeIds: [exit] }],
    });
    return exit;
  }

  it('gets no IPv6 on the entry, in the push, the peers or the client config; the exit node is as any other', async () => {
    const { n, sq } = await tunnelNode();
    // The chain runs on sing-box, and an entry that reports none is refused.
    await setCores(
      n,
      [awgRow(), { name: 'wireguard', engine: 'wireguard', running: true, installed: true }, { name: 'tuic', engine: 'singbox', running: true, installed: true }],
      ipv6Facts(),
    );
    const exit = await cascadeOnto(n);
    expect(await awgInterfacesInChain(n)).toEqual({ one: true, three: true });
    expect(await awgInterfacesInChain(exit)).toEqual({ one: false, three: false });
    // Plain WireGuard is not an entry protocol: its interface keeps IPv6.
    await expect(tunnelIpv6OfNode(n)).resolves.toEqual({ one: false, three: false, wg: true });

    const a = await user('v6_chain', [sq.id]);
    const inbounds = await fetchEnabledInbounds(n);
    expect(cfgAt(inbounds, 51820).subnet6).toBeUndefined();
    expect(cfgAt(inbounds, 51830).subnet6).toBeUndefined();
    expect(cfgAt(inbounds, 51840).subnet6).toBe(S6_W);

    const { added } = capture();
    await applyInboundsForNode(n);
    const p = added.find((r) => r.userId === a)!.credentials.amneziawgPeers![0]!;
    expect(p.allowedIp6).toBeUndefined();
    expect(p.allowedIp3v6).toBeUndefined();
    expect(p.wireguardAllowedIp6).toBeTruthy();

    const t = (await prisma.user.findUniqueOrThrow({ where: { id: a }, select: { subscriptionToken: true } })).subscriptionToken;
    const res = await app.inject({ method: 'GET', url: `/sub/${t}?format=wgconf`, remoteAddress: '10.79.2.1' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toMatch(/^Address = 10\.66\.66\.\d+\/32$/m);
  });

  it('only the interface handed over loses it: a cascade entered on the 1.x one only', async () => {
    const n = await makeNode();
    const three = await profile('amneziawg', awgCfg('10.67.67.0/24', S6_3), { awgProtocol: 3 });
    await setCores(
      n,
      [awgRow(), { name: 'tuic', engine: 'singbox', running: true, installed: true }],
      ipv6Facts(),
    );
    await host(three, n, 51830);
    await cascadeOnto(n);
    // The entry's AmneziaWG is a 3.1 one alone, and that is the handed-over interface.
    expect(await awgInterfacesInChain(n)).toEqual({ one: false, three: true });
    expect(await tunnelIpv6OfNode(n)).toEqual({ one: true, three: false, wg: true });
  });

  it('an unknown node is no IPv6', async () => {
    await expect(tunnelIpv6OfNode('00000000-0000-0000-0000-000000000000')).resolves.toEqual(NO_TUNNEL_IPV6);
  });
});
