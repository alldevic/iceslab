import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeCores } from '@iceslab/shared';
import { nodeExitsViaIpv6 } from '../nodes/node-core-gate.js';
import { linkListenOf, linkSourcesOf, nodeIpv6FactOf } from './link-ipv6.js';
import { buildCascadeConfigs, buildTopologyFragmentsForNode, type LinkCred, type TopologyInput } from './cascade.config.js';
import { chainLinkIngressOf } from './cascade.service.js';
import { renderChainConfig } from './chain.config.js';
import { entryInput, exitInput, transitInput } from './chain.config.test.js';

/**
 * 18.8: a cascade over IPv6. The facts (stack, addresses, exit) come from the
 * node's report and its mode; unknown is "none", and then nothing is drawn
 * differently. Listeners bind `::` where the stack is there, the next hop's
 * firewall names the previous hop's IPv6 addresses beside its recorded one, and
 * the chain's `direct` prefers IPv6 where the node leaves by it.
 */
const SINGBOX_BIN =
  process.env.SINGBOX_BIN ?? ['/usr/local/bin/sing-box', '/usr/bin/sing-box'].find((p) => existsSync(p)) ?? '';
const XRAY_BIN = process.env.XRAY_BIN ?? ['/usr/local/bin/xray', '/usr/bin/xray'].find((p) => existsSync(p)) ?? '';

const cores = (ipv6?: NodeCores['ipv6']): NodeCores =>
  ({ cores: [], observedAt: '2026-11-27T00:00:00Z', ...(ipv6 ? { ipv6 } : {}) }) as unknown as NodeCores;
const v6 = (o: Partial<NonNullable<NodeCores['ipv6']>> = {}) => ({
  stack: true,
  global: true,
  addresses: ['2001:db8::2', '2001:db8::1'],
  ...o,
});

describe('nodeExitsViaIpv6', () => {
  it('on and off are the operator\'s word, auto needs a global address and an egress that went through', () => {
    // No ipv6 block: an agent that reports none applies no mode either (18.7).
    expect(nodeExitsViaIpv6(null, 'on')).toBe(false);
    expect(nodeExitsViaIpv6(cores(v6({ egress: true })), 'off')).toBe(false);
    expect(nodeExitsViaIpv6(cores(v6({ egress: true })), 'auto')).toBe(true);
    expect(nodeExitsViaIpv6(cores(v6({ egress: false })), 'auto')).toBe(false);
    expect(nodeExitsViaIpv6(cores(v6({ global: false, egress: true })), 'auto')).toBe(false);
  });

  it('reads a missing fact as no', () => {
    expect(nodeExitsViaIpv6(null, 'auto')).toBe(false);
    expect(nodeExitsViaIpv6(cores(), 'auto')).toBe(false);
    expect(nodeExitsViaIpv6(cores(v6()), 'auto')).toBe(false); // an agent older than the egress check
  });
});

describe('nodeIpv6FactOf', () => {
  it('is nothing for a node that reports nothing, whatever the mode does not touch', () => {
    expect(nodeIpv6FactOf(null, 'auto')).toBeUndefined();
    expect(nodeIpv6FactOf(cores(), undefined)).toBeUndefined();
    expect(nodeIpv6FactOf(cores(v6({ stack: false, global: false, addresses: [] })), 'auto')).toBeUndefined();
  });

  it('carries the stack, the sorted global addresses and the exit', () => {
    expect(nodeIpv6FactOf(cores(v6({ egress: true })), 'auto')).toEqual({
      stack: true,
      addresses: ['2001:db8::1', '2001:db8::2'],
      exits: true,
    });
    expect(nodeIpv6FactOf(cores(v6()), 'on')).toMatchObject({ exits: true });
  });

  it('drops what is not an IPv6 literal', () => {
    expect(nodeIpv6FactOf(cores(v6({ addresses: ['10.0.0.1', 'garbage', '2001:db8::1'] })), 'auto')?.addresses).toEqual([
      '2001:db8::1',
    ]);
  });
});

describe('linkListenOf, linkSourcesOf', () => {
  it('binds :: only on a known stack', () => {
    expect(linkListenOf(undefined)).toBe('0.0.0.0');
    expect(linkListenOf({ stack: false, addresses: ['2001:db8::1'], exits: false })).toBe('0.0.0.0');
    expect(linkListenOf({ stack: true, addresses: [], exits: false })).toBe('::');
  });

  it('adds the addresses to the recorded one, without a duplicate', () => {
    const f = { stack: true, addresses: ['2001:db8::1', '2001:db8::2'], exits: false };
    expect(linkSourcesOf('1.1.1.1', f)).toEqual(['1.1.1.1', '2001:db8::1', '2001:db8::2']);
    expect(linkSourcesOf('2001:db8::1', f)).toEqual(['2001:db8::1', '2001:db8::2']);
    expect(linkSourcesOf('1.1.1.1', undefined)).toEqual(['1.1.1.1']);
  });
});

const N = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const link = (from: string, to: string, tag: number, port: number) => ({
  fromNodeId: from,
  toNodeId: to,
  directionTag: tag,
  cred: { protocol: 'vless' as const, port, uuid: N(tag) },
});
const topo = (nodeIpv6?: TopologyInput['nodeIpv6']): TopologyInput => ({
  positions: [
    { position: 0, nodeIds: ['entry'] },
    { position: 1, nodeIds: ['transit'] },
  ],
  directions: [{ tag: 1, nodeIds: ['exit'] }],
  links: [link('entry', 'transit', 1, 24000), link('transit', 'exit', 1, 24001)],
  hosts: new Map([
    ['entry', '1.1.1.1'],
    ['transit', 'transit.example'],
    ['exit', '3.3.3.3'],
  ]),
  ...(nodeIpv6 ? { nodeIpv6 } : {}),
});
const fact = { stack: true, addresses: ['2001:db8::1'], exits: false };

describe('the xray drawing', () => {
  const listenOf = (t: TopologyInput, node: string) =>
    buildTopologyFragmentsForNode(node, t)?.inbounds.find((i) => i.tag === 'cascade-link-in')?.listen;

  it('listens on :: where the receiving node reports the stack, on 0.0.0.0 otherwise', () => {
    const t = topo(new Map([['transit', fact]]));
    expect(listenOf(t, 'transit')).toBe('::');
    expect(listenOf(t, 'exit')).toBe('0.0.0.0');
  });

  it('a node the report does not know is drawn byte for byte as without any fact', () => {
    const plain = JSON.stringify(buildTopologyFragmentsForNode('transit', topo()));
    expect(JSON.stringify(buildTopologyFragmentsForNode('transit', topo(new Map())))).toBe(plain);
    expect(JSON.stringify(buildTopologyFragmentsForNode('transit', topo(new Map([['exit', fact]]))))).toBe(plain);
  });

  it("names the previous hop's IPv6 addresses beside its recorded host", () => {
    const t = topo(new Map([['entry', fact]]));
    expect(buildTopologyFragmentsForNode('transit', t)?.linkAllowFrom).toEqual(['1.1.1.1', '2001:db8::1']);
  });

  it('the legacy hop drawing follows the same rule', () => {
    const cred = { protocol: 'vless', port: 24000, uuid: N(1) } as unknown as LinkCred;
    const hops = [
      { nodeId: 'e', position: 0, nodeHost: '1.1.1.1', ipv6: fact },
      { nodeId: 'x', position: 1, nodeHost: 'x.example', ipv6: fact },
    ];
    const [, exit] = buildCascadeConfigs(hops, [cred]);
    expect(exit!.inbounds[0]!.listen).toBe('::');
    expect(exit!.linkAllowFrom).toEqual(['1.1.1.1', '2001:db8::1']);
    const [, plain] = buildCascadeConfigs(hops.map((h) => ({ nodeId: h.nodeId, position: h.position, nodeHost: h.nodeHost })), [cred]);
    expect(plain!.inbounds[0]!.listen).toBe('0.0.0.0');
    expect(plain!.linkAllowFrom).toEqual(['1.1.1.1']);
  });

  it.skipIf(!XRAY_BIN)('is a config xray loads, listener on ::', () => {
    const t = topo(new Map([['transit', fact], ['entry', fact]]));
    const frag = buildTopologyFragmentsForNode('transit', t)!;
    const config = {
      log: { loglevel: 'warning' },
      inbounds: [
        { tag: 'vless-in', port: 443, listen: '0.0.0.0', protocol: 'vless', settings: { clients: [{ id: N(9) }], decryption: 'none' }, streamSettings: { network: 'raw', security: 'none' } },
        ...frag.inbounds,
      ],
      outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'blocked', protocol: 'blackhole' }, ...frag.outbounds.filter((o) => o.tag !== 'direct')],
      routing: { rules: frag.routingRules },
    };
    expect((frag.inbounds[0] as { listen: string }).listen).toBe('::');
    const file = join(mkdtempSync(join(tmpdir(), 'iceslab-v6-xray-')), 'config.json');
    writeFileSync(file, JSON.stringify(config));
    expect(() => execFileSync(XRAY_BIN, ['-test', '-c', file], { encoding: 'utf8', stdio: 'pipe' })).not.toThrow();
  });
});

describe('chainLinkIngressOf', () => {
  it('allowFrom: the recorded address and the previous hop\'s IPv6 addresses, sorted, no duplicates', () => {
    const f = { stack: true, addresses: ['2001:db8::2', '2001:db8::1'], exits: false };
    const t = topo(new Map([['entry', f]]));
    t.hosts.set('entry', '2001:db8::1');
    t.links.push(link('other', 'transit', 2, 24000));
    t.hosts.set('other', '4.4.4.4');
    expect(chainLinkIngressOf('transit', t)).toEqual([
      { port: 24000, transports: ['tcp'], allowFrom: ['2001:db8::1', '2001:db8::2', '4.4.4.4'] },
    ]);
  });

  it('a previous hop recorded by IPv4 and dialled over IPv6: the rule names both', () => {
    const t = topo(new Map([['entry', fact]]));
    expect(chainLinkIngressOf('transit', t)[0]!.allowFrom).toEqual(['1.1.1.1', '2001:db8::1']);
  });

  it('no fact, no change', () => {
    expect(chainLinkIngressOf('transit', topo())[0]!.allowFrom).toEqual(['1.1.1.1']);
  });
});

describe('the chain', () => {
  type Cfg = { dns?: unknown; inbounds: { tag: string; listen: string }[]; outbounds: Record<string, unknown>[] };
  const render = (i: Parameters<typeof renderChainConfig>[0]) => renderChainConfig(i) as unknown as Cfg;

  it('the link listener binds :: with the stack, and keeps the tag link-in', () => {
    const cfg = render({ ...transitInput, in: { ...transitInput.in!, dualStack: true } });
    const links = cfg.inbounds.filter((i) => i.tag.startsWith('link-in'));
    expect(links.map((i) => [i.tag, i.listen])).toEqual([['link-in', '::']]);
  });

  it('without the stack the render is byte for byte the old one', () => {
    for (const input of [entryInput, transitInput, exitInput]) {
      expect(JSON.stringify(render({ ...input, egressIpv6: false }))).toBe(JSON.stringify(render(input)));
      if (input.in) expect(JSON.stringify(render({ ...input, in: { ...input.in, dualStack: false } }))).toBe(JSON.stringify(render(input)));
    }
  });

  it('tunnel listeners win over the stack', () => {
    const cfg = render({ ...transitInput, in: { ...transitInput.in!, dualStack: true, listen: ['10.9.0.1'] } });
    expect(cfg.inbounds.filter((i) => i.tag.startsWith('link-in')).map((i) => i.listen)).toEqual(['10.9.0.1']);
  });

  it('direct prefers IPv6 where the node leaves by it, with the resolver declared', () => {
    const cfg = render({ ...exitInput, egressIpv6: true });
    expect(cfg.outbounds.find((o) => o.tag === 'direct')).toEqual({
      type: 'direct',
      tag: 'direct',
      domain_resolver: { server: 'leg-dns', strategy: 'prefer_ipv6' },
    });
    expect(cfg.dns).toEqual({ servers: [{ type: 'local', tag: 'leg-dns' }] });
    // and it is the same direct on every role
    expect(render({ ...entryInput, egressIpv6: true }).outbounds.find((o) => o.tag === 'direct')).toHaveProperty('domain_resolver');
  });

  it('one resolver server when a pinned leg and the exit both need it', () => {
    const cfg = render({
      ...transitInput,
      selfHost: '10.0.0.1',
      egressIpv6: true,
      out: (transitInput.out ?? []).map((l) => ({ ...l, host: 'next.example.com' })),
    });
    expect((cfg.dns as { servers: unknown[] }).servers).toHaveLength(1);
  });

  it.skipIf(!SINGBOX_BIN)('is a config sing-box 1.13 loads: :: listener and a preferring direct', () => {
    for (const input of [exitInput, transitInput, entryInput]) {
      const cfg = renderChainConfig({
        ...input,
        egressIpv6: true,
        ...(input.in ? { in: { ...input.in, dualStack: true } } : {}),
      });
      const file = join(mkdtempSync(join(tmpdir(), 'iceslab-v6-chain-')), 'config.json');
      writeFileSync(file, JSON.stringify(cfg));
      try {
        execFileSync(SINGBOX_BIN, ['check', '-c', file], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        throw new Error(`${input.role}: ${e.stdout ?? ''}${e.stderr ?? ''}`, { cause: err });
      }
    }
  });
});
