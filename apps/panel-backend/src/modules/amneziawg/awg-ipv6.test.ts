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
import { invalidateSubscriptionSettingsCache } from '../settings/settings.service.js';
import { applyInboundsForNode, fetchEnabledInbounds } from '../inbounds/inbounds.queue.js';
import { syncAddUser } from '../users/users.queue.js';
import { awgInterfacesInChain, getChainForNode } from '../cascades/cascade.service.js';
import { TPROXY6_IN_TAG } from '../cascades/chain.config.js';
import { interfaceCarriesIpv6, NO_TUNNEL_IPV6, nodeAgentCarriesTunnelIpv6, nodeAgentSteersIpv6, tunnelIpv6OfNode } from './awg-ipv6.js';
import { ipv4OfIpv6, ipv6OfIpv4, ipv6OfIpv4InPrefix } from './amneziawg.subnet.js';
import { nodeAgentServesRealPrefix, tunnelAddressing } from './awg-ipv6.js';

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

  it('18.12: an interface in a chain carries it only when the chain can (the 4th argument), the other ones as before', () => {
    const inChain = { one: true, three: false };
    expect(interfaceCarriesIpv6(full, 'one', inChain, true)).toBe(true);
    expect(interfaceCarriesIpv6(full, 'one', inChain, false)).toBe(false);
    expect(interfaceCarriesIpv6(full, 'one', inChain)).toBe(false);
    // The chain's answer lifts nothing the agent facts forbid.
    const off = { cores: coresOf([awgRow({ awgIpv6: false })], ipv6Facts()), ipv6Mode: 'auto' as const };
    expect(interfaceCarriesIpv6(off, 'one', inChain, true)).toBe(false);
    expect(interfaceCarriesIpv6({ ...full, ipv6Mode: 'off' }, 'one', inChain, true)).toBe(false);
  });

  it('the awgTproxy6 fact: only a true on the amneziawg row says the agent steers IPv6', () => {
    expect(nodeAgentSteersIpv6(coresOf([awgRow({ awgTproxy6: true })], ipv6Facts()))).toBe(true);
    expect(nodeAgentSteersIpv6(coresOf([awgRow({ awgTproxy6: false })], ipv6Facts()))).toBe(false);
    expect(nodeAgentSteersIpv6(coresOf([awgRow()], ipv6Facts()))).toBe(false);
    expect(nodeAgentSteersIpv6(coresOf([{ name: 'xray', engine: 'xray', running: true, installed: true, awgTproxy6: true }], ipv6Facts()))).toBe(false);
    expect(nodeAgentSteersIpv6(null)).toBe(false);
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
async function post(url: string, payload: unknown, method: 'POST' | 'PUT' = 'POST') {
  const res = await app.inject({ method, url, headers: auth(), payload });
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

describe('an interface given to a cascade chain, the agent that cannot steer IPv6 (the ban of 18.9)', () => {
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

/**
 * 18.12: the ban of 18.9 lifted by a condition. An interface handed to a chain
 * carries IPv6 when the agent steers it (awgTproxy6) AND an exit of the cascade
 * leaves by IPv6 (nodeExitsViaIpv6, 18.7); the push, the agent's hand-off, the
 * chain's `::1` listener and the client configs all read the one answer.
 */
describe('an interface given to a cascade chain, the agent that steers IPv6 (18.12)', () => {
  const sing = { name: 'tuic', engine: 'singbox', running: true, installed: true } as CoreStatus;
  const wgRow = { name: 'wireguard', engine: 'wireguard', running: true, installed: true } as CoreStatus;

  async function chainedEntry(opts: { exitIpv6?: NodeIPv6 | null; exitMode?: 'auto' | 'on' | 'off'; steers?: boolean }) {
    const { n, sq } = await tunnelNode();
    await setCores(n, [awgRow({ awgTproxy6: opts.steers ?? true }), wgRow, sing], ipv6Facts());
    const exit = await makeNode('nl-exit');
    if (opts.exitIpv6 !== null) {
      await setCores(exit, [{ name: 'xray', engine: 'xray', running: true, installed: true }], opts.exitIpv6 ?? ipv6Facts({ egress: true }), opts.exitMode);
    } else if (opts.exitMode) {
      await prisma.node.update({ where: { id: exit }, data: { ipv6Mode: opts.exitMode } });
    }
    seq += 1;
    await post('/api/cascades', {
      name: `ru-out-${seq}`,
      enabled: true,
      autoProfile: false,
      positions: [{ position: 0, nodeIds: [n], entryProtocol: 'amneziawg', linkProtocol: 'vless' }],
      directions: [{ countryCode: 'NL', nodeIds: [exit] }],
    });
    return { n, sq, exit };
  }

  it('exits with IPv6: the interfaces carry it, the push has subnet6, the hand-off and the chain say so', async () => {
    const { n, sq } = await chainedEntry({});
    expect(await awgInterfacesInChain(n)).toEqual({ one: true, three: true });
    await expect(tunnelIpv6OfNode(n)).resolves.toEqual({ one: true, three: true, wg: true });

    const inbounds = await fetchEnabledInbounds(n);
    expect(cfgAt(inbounds, 51820).subnet6).toBe(S6_1);
    expect(cfgAt(inbounds, 51830).subnet6).toBe(S6_3);

    const chain = await getChainForNode(n);
    expect(chain?.userCore).toMatchObject({
      engine: 'amneziawg',
      tproxy: { ipv6: true },
      tproxy3: { ipv6: true },
    });
    const cfg = chain!.config as { inbounds: { tag: string; listen?: string }[] };
    expect(cfg.inbounds.find((i) => i.tag === TPROXY6_IN_TAG)).toMatchObject({ type: 'tproxy', listen: '::1' });

    const a = await user('v6_chain_ok', [sq.id]);
    const { added } = capture();
    await applyInboundsForNode(n);
    const p = added.find((r) => r.userId === a)!.credentials.amneziawgPeers![0]!;
    expect(p.allowedIp6).toBeTruthy();
    expect(p.allowedIp3v6).toBeTruthy();
    const t = (await prisma.user.findUniqueOrThrow({ where: { id: a }, select: { subscriptionToken: true } })).subscriptionToken;
    const res = await app.inject({ method: 'GET', url: `/sub/${t}?format=wgconf`, remoteAddress: '10.79.2.2' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toMatch(/^Address = 10\.66\.66\.\d+\/32, fd12:/m);
  });

  it('only the interface that is in the chain and has a port is told to steer IPv6', async () => {
    const n = await makeNode();
    const three = await profile('amneziawg', awgCfg('10.67.67.0/24', S6_3), { awgProtocol: 3 });
    await setCores(n, [awgRow({ awgTproxy6: true }), sing], ipv6Facts());
    await host(three, n, 51830);
    const exit = await makeNode('nl-exit');
    await setCores(exit, [{ name: 'xray', engine: 'xray', running: true, installed: true }], ipv6Facts({ egress: true }));
    await post('/api/cascades', {
      name: 'ru-out-3',
      enabled: true,
      autoProfile: false,
      positions: [{ position: 0, nodeIds: [n], entryProtocol: 'amneziawg', linkProtocol: 'vless' }],
      directions: [{ countryCode: 'NL', nodeIds: [exit] }],
    });
    const chain = await getChainForNode(n);
    expect(chain?.userCore).toEqual({
      engine: 'amneziawg',
      tproxy3: expect.objectContaining({ ipv6: true }),
    });
    expect(chain!.userCore).not.toHaveProperty('tproxy');
  });

  it('the agent cannot steer IPv6 (no awgTproxy6): the interfaces have none, hand-off and chain are the old ones', async () => {
    const { n, sq } = await chainedEntry({ steers: false });
    await expect(tunnelIpv6OfNode(n)).resolves.toEqual({ one: false, three: false, wg: true });
    expect(cfgAt(await fetchEnabledInbounds(n), 51820).subnet6).toBeUndefined();
    const chain = await getChainForNode(n);
    expect(JSON.stringify(chain!.userCore)).not.toContain('ipv6');
    expect(JSON.stringify(chain!.config)).not.toContain(TPROXY6_IN_TAG);
    const a = await user('v6_chain_nosteer', [sq.id]);
    const t = (await prisma.user.findUniqueOrThrow({ where: { id: a }, select: { subscriptionToken: true } })).subscriptionToken;
    const res = await app.inject({ method: 'GET', url: `/sub/${t}?format=wgconf`, remoteAddress: '10.79.2.3' });
    expect(res.body).toMatch(/^Address = 10\.66\.66\.\d+\/32$/m);
  });

  it.each([
    ['an exit that reported no IPv6 block', { exitIpv6: null }],
    ['an exit with no egress (auto)', { exitIpv6: ipv6Facts({ egress: false }) }],
    ['an exit whose IPv6 mode is off', { exitIpv6: ipv6Facts({ egress: true }), exitMode: 'off' as const }],
  ])('%s: the client gets no IPv6 address and the entry no way to let it out directly', async (_n, opts) => {
    const { n, sq } = await chainedEntry(opts);
    await expect(tunnelIpv6OfNode(n)).resolves.toEqual({ one: false, three: false, wg: true });
    const chain = await getChainForNode(n);
    expect(JSON.stringify(chain!.userCore)).not.toContain('ipv6');
    const a = await user('v6_chain_noexit', [sq.id]);
    const { added } = capture();
    await applyInboundsForNode(n);
    const p = added.find((r) => r.userId === a)!.credentials.amneziawgPeers![0]!;
    expect(p.allowedIp6).toBeUndefined();
    const t = (await prisma.user.findUniqueOrThrow({ where: { id: a }, select: { subscriptionToken: true } })).subscriptionToken;
    // `::/0` is the operator's switch (wgDropIpv6, 18.7), as for any tunnel with no
    // IPv6 address of its own: the default config keeps it, the switch takes it out.
    const conf = () => app.inject({ method: 'GET', url: `/sub/${t}?format=wgconf`, remoteAddress: '10.79.2.4' });
    const res = await conf();
    expect(res.body).toMatch(/^Address = 10\.66\.66\.\d+\/32$/m);
    expect(res.body).toMatch(/^AllowedIPs = 0\.0\.0\.0\/0, ::\/0$/m);
    await post('/api/settings', { subscriptionWgDropIpv6: true }, 'PUT');
    invalidateSubscriptionSettingsCache();
    expect((await conf()).body).toMatch(/^AllowedIPs = 0\.0\.0\.0\/0$/m);
  });

  it('the exit mode "on" (an operator\'s word) counts as IPv6 at the exit', async () => {
    const { n } = await chainedEntry({ exitIpv6: ipv6Facts({ egress: false }), exitMode: 'on' });
    await expect(tunnelIpv6OfNode(n)).resolves.toMatchObject({ one: true, three: true });
  });

  it('a real prefix on the entry is split among the chained interfaces like any other (the exit connects from its own address)', async () => {
    const { n } = await chainedEntry({});
    await setCores(n, [awgRow({ awgTproxy6: true, awgNoNat6: true }), wgRow, sing], ipv6Facts());
    await prisma.node.update({ where: { id: n }, data: { tunnelIpv6Prefix: '2001:db8:77::/48' } });
    const t = await tunnelIpv6OfNode(n);
    expect(t.real).toEqual({ one: '2001:db8:77:0::/64', three: '2001:db8:77:1::/64', wg: '2001:db8:77:2::/64' });
    const inbounds = await fetchEnabledInbounds(n);
    expect(cfgAt(inbounds, 51820)).toMatchObject({ subnet6: '2001:db8:77:0::/64', noNat6: true });
    expect(cfgAt(inbounds, 51830)).toMatchObject({ subnet6: '2001:db8:77:1::/64', noNat6: true });
  });
});

/**
 * 18.11: a node with a real prefix. The interfaces that carry IPv6 are given a
 * /64 of it in the order 1.x, 3.1, plain WireGuard; the push says `noNat6`; the
 * peers and the client configs are derived in that /64. A node without the prefix,
 * or whose agent does not say `awgNoNat6`, is the node of 18.10.
 */
describe('a node with a real prefix', () => {
  const PREFIX = '2001:db8:77::/48';
  const real = (i: number) => `2001:db8:77:${i}::/64`;
  const wgRow = { name: 'wireguard', engine: 'wireguard', running: true, installed: true } as CoreStatus;
  const withPrefix = async (n: string, prefix: string | null, over: Partial<CoreStatus> = { awgNoNat6: true }) => {
    await setCores(n, [awgRow(over), wgRow], ipv6Facts());
    await prisma.node.update({ where: { id: n }, data: { tunnelIpv6Prefix: prefix } });
  };

  it('tunnelAddressing: the real /64 and no NAT where the node has one, the profile\'s and NAT66 elsewhere, nothing without IPv6', () => {
    const t = { one: true, three: true, wg: false, real: { one: real(0) } };
    expect(tunnelAddressing(t, 'one', S6_1)).toEqual({ subnet6: real(0), noNat: true });
    expect(tunnelAddressing(t, 'three', S6_3)).toEqual({ subnet6: S6_3, noNat: false });
    expect(tunnelAddressing(t, 'wg', S6_W)).toBeUndefined();
    expect(tunnelAddressing(t, 'one', undefined)).toBeUndefined();
    expect(tunnelAddressing(null, 'one', S6_1)).toBeUndefined();
  });

  it('the fact: only an agent that says awgNoNat6 serves one', () => {
    expect(nodeAgentServesRealPrefix(coresOf([awgRow({ awgNoNat6: true })], ipv6Facts()))).toBe(true);
    expect(nodeAgentServesRealPrefix(coresOf([awgRow()], ipv6Facts()))).toBe(false);
    expect(nodeAgentServesRealPrefix(coresOf([awgRow({ awgNoNat6: false })], ipv6Facts()))).toBe(false);
    expect(nodeAgentServesRealPrefix(null)).toBe(false);
  });

  it('a /48 gives each interface a /64 of its own, in order; the push has noNat6 on each', async () => {
    const { n } = await tunnelNode();
    await withPrefix(n, PREFIX);
    await expect(tunnelIpv6OfNode(n)).resolves.toEqual({
      one: true,
      three: true,
      wg: true,
      real: { one: real(0), three: real(1), wg: real(2) },
    });
    const inbounds = await fetchEnabledInbounds(n);
    for (const [port, i] of [[51820, 0], [51830, 1], [51840, 2]] as const) {
      const c = cfgAt(inbounds, port);
      expect(c.subnet6, String(port)).toBe(real(i));
      expect(c.noNat6, String(port)).toBe(true);
      // The IPv4 half and the injected keys are as they were.
      expect(c.listenPort).toBe(port);
    }
    expect(cfgAt(inbounds, 51820).subnet).toBe('10.66.66.0/24');
  });

  it('a prefix that is exactly /64 goes to the first interface only; the others stay on NAT66', async () => {
    const { n } = await tunnelNode();
    await withPrefix(n, real(5));
    const inbounds = await fetchEnabledInbounds(n);
    expect(cfgAt(inbounds, 51820)).toMatchObject({ subnet6: real(5), noNat6: true });
    expect(cfgAt(inbounds, 51830).subnet6).toBe(S6_3);
    expect(cfgAt(inbounds, 51830).noNat6).toBeUndefined();
    expect(cfgAt(inbounds, 51840).subnet6).toBe(S6_W);
    expect(cfgAt(inbounds, 51840).noNat6).toBeUndefined();
  });

  it('an interface whose profile has no subnet6 does not use up a /64', async () => {
    const n = await makeNode();
    const one = await profile('amneziawg', awgCfg('10.66.66.0/24'));
    const plain = await profile('wireguard', wgCfg('10.77.77.0/24', S6_W));
    await host(one, n, 51820);
    await host(plain, n, 51840);
    await withPrefix(n, real(5));
    const inbounds = await fetchEnabledInbounds(n);
    expect(cfgAt(inbounds, 51820).subnet6).toBeUndefined();
    expect(cfgAt(inbounds, 51840)).toMatchObject({ subnet6: real(5), noNat6: true });
  });

  it('an agent without awgNoNat6 (18.10), mode off or no prefix: the request of 18.10, byte for byte', async () => {
    const { n } = await tunnelNode();
    const base = JSON.stringify(await fetchEnabledInbounds(n));
    expect(base).not.toContain('noNat6');
    await withPrefix(n, PREFIX, {}); // the agent does not say awgNoNat6
    expect(JSON.stringify(await fetchEnabledInbounds(n))).toBe(base);
    await withPrefix(n, null); // the agent does, there is no prefix
    expect(JSON.stringify(await fetchEnabledInbounds(n))).toBe(base);
    await withPrefix(n, PREFIX);
    expect(JSON.stringify(await fetchEnabledInbounds(n))).not.toBe(base);
    await prisma.node.update({ where: { id: n }, data: { ipv6Mode: 'off' } });
    expect(JSON.stringify(await fetchEnabledInbounds(n))).not.toContain('2001:db8');
  });

  it('a profile without subnet6 on a node with a prefix is the old request', async () => {
    const { n } = await tunnelNode({ v6: false });
    await withPrefix(n, PREFIX);
    expect(JSON.stringify(await fetchEnabledInbounds(n))).not.toMatch(/subnet6|noNat6/);
  });

  it('the peers are derived in the node\'s /64, one-to-one with their IPv4; the rolled-out user is the same', async () => {
    const { n, sq } = await tunnelNode();
    await withPrefix(n, PREFIX);
    const a = await user('v6_real', [sq.id]);
    const pushed = capture();
    await applyInboundsForNode(n);
    const peers = pushed.added.find((r) => r.userId === a)!.credentials.amneziawgPeers!;
    const p = peers[0]!;
    expect(p.allowedIp6).toBe(ipv6OfIpv4InPrefix(real(0), p.allowedIp!));
    expect(p.allowedIp3v6).toBe(ipv6OfIpv4InPrefix(real(1), p.allowedIp3!));
    expect(p.wireguardAllowedIp6).toBe(ipv6OfIpv4InPrefix(real(2), p.wireguardAllowedIp!));
    expect(p.allowedIp6!.startsWith('2001:db8:77:0:')).toBe(true);
    expect(ipv4OfIpv6(S6_1, ipv6OfIpv4(S6_1, p.allowedIp!))).toBe(p.allowedIp);
    vi.restoreAllMocks();
    vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
    const rolled = capture();
    await syncAddUser(a);
    expect(rolled.added.find((r) => r.userId === a)!.credentials.amneziawgPeers).toEqual(peers);
  });

  it('one profile on two nodes, one with a prefix and one without: the client gets the prefix address for the first and the profile\'s for the second', async () => {
    const withReal = await makeNode('real');
    const without = await makeNode('nat');
    const prof = await profile('amneziawg', awgCfg('10.66.66.0/24', S6_1));
    await host(prof, withReal, 51820);
    await host(prof, without, 51820);
    await setCores(without, [awgRow({ awgNoNat6: true }), wgRow], ipv6Facts());
    await withPrefix(withReal, PREFIX);
    const sq = await post('/api/squads', { name: `v6-sq-${++seq}`, profileIds: [prof] });
    const a = await user('v6_two', [sq.id]);
    const t = (await prisma.user.findUniqueOrThrow({ where: { id: a }, select: { subscriptionToken: true } })).subscriptionToken;
    const nodeName = async (id: string) => (await prisma.node.findUniqueOrThrow({ where: { id } })).name;
    const conf = async (id: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/sub/${t}?format=wgconf&node=${encodeURIComponent(await nodeName(id))}`,
        remoteAddress: `10.79.3.${++seq}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      return /^Address = (.+)$/m.exec(res.body)![1]!;
    };
    const first = await conf(withReal);
    const second = await conf(without);
    const [v4, v6] = first.split(', ');
    expect(v6).toBe(`${ipv6OfIpv4InPrefix(real(0), v4!.replace('/32', ''))}/128`);
    expect(v6!.startsWith('2001:db8:77:0:')).toBe(true);
    const [v4b, v6b] = second.split(', ');
    expect(v4b).toBe(v4);
    expect(v6b).toBe(`${ipv6OfIpv4(S6_1, v4b!.replace('/32', ''))}/128`);
    expect(v6b!.startsWith('fd12:')).toBe(true);
  });

  it('changing the prefix changes every pushed address and nothing of the IPv4 half', async () => {
    const { n, sq } = await tunnelNode();
    const a = await user('v6_move', [sq.id]);
    await withPrefix(n, PREFIX);
    const first = capture();
    await applyInboundsForNode(n);
    const before = first.added.find((r) => r.userId === a)!.credentials.amneziawgPeers![0]!;
    await prisma.node.update({ where: { id: n }, data: { tunnelIpv6Prefix: '2001:db8:88::/48' } });
    vi.restoreAllMocks();
    vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
    const second = capture();
    await applyInboundsForNode(n);
    const after = second.added.find((r) => r.userId === a)!.credentials.amneziawgPeers![0]!;
    expect(after.allowedIp).toBe(before.allowedIp);
    expect(after.allowedIp6).toBe(ipv6OfIpv4InPrefix('2001:db8:88:0::/64', before.allowedIp!));
    expect(after.allowedIp6).not.toBe(before.allowedIp6);
  });
});
