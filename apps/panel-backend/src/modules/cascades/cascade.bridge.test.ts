import { describe, expect, it } from 'vitest';
import {
  BRIDGE_IN_TAG,
  BRIDGE_SOCKS_PORT,
  bridgeSocksPortFromInbounds,
  buildTopologyFragmentsForNode,
} from './cascade.config.js';

/**
 * Bridge A (2026-09-02). Cascade, split-routing and egress policy are all
 * compiled into xray rules, and only xray runs them. A TUIC / AnyTLS /
 * ShadowTLS / Hysteria2 client is served by sing-box, which renders no routing
 * at all - so today its traffic never reaches those rules and leaves the entry
 * node directly, while the buyer's subscription says it comes out abroad.
 *
 * The bridge is a loopback socks inbound on the entry's xray plus the rule that
 * steers what arrives there. These tests pin the two things that make it safe:
 * the inbound and the rule are emitted TOGETHER, and the rule sits below the
 * geo split (so ru-split still wins) and above the terminal refusal.
 */

const ENTRY = 'aaaaaaaa-0000-0000-0000-000000000001';
const EXIT_A = 'bbbbbbbb-0000-0000-0000-000000000002';
const EXIT_B = 'cccccccc-0000-0000-0000-000000000003';

const oneDirection = {
  positions: [{ position: 0, nodeIds: [ENTRY] }],
  directions: [{ tag: 1, nodeIds: [EXIT_A] }],
  links: [
    {
      fromNodeId: ENTRY,
      toNodeId: EXIT_A,
      directionTag: 1,
      cred: { protocol: 'vless' as const, port: 24000, uuid: 'u-1' },
    },
  ],
  hosts: new Map([[EXIT_A, 'a.example']]),
};

const twoDirections = {
  positions: [{ position: 0, nodeIds: [ENTRY] }],
  directions: [
    { tag: 1, nodeIds: [EXIT_A] },
    { tag: 2, nodeIds: [EXIT_B] },
  ],
  links: [
    {
      fromNodeId: ENTRY,
      toNodeId: EXIT_A,
      directionTag: 1,
      cred: { protocol: 'vless' as const, port: 24000, uuid: 'u-1' },
    },
    {
      fromNodeId: ENTRY,
      toNodeId: EXIT_B,
      directionTag: 2,
      cred: { protocol: 'vless' as const, port: 24000, uuid: 'u-2' },
    },
  ],
  hosts: new Map([
    [EXIT_A, 'a.example'],
    [EXIT_B, 'b.example'],
  ]),
};

const isBridgeRule = (r: Record<string, unknown>) =>
  Array.isArray(r.inboundTag) && (r.inboundTag as string[]).includes(BRIDGE_IN_TAG);

describe('bridge A: a non-xray core joins the cascade through the local xray', () => {
  it('emits nothing at all unless a bridge was asked for', () => {
    const hop = buildTopologyFragmentsForNode(ENTRY, oneDirection)!;
    expect(hop.inbounds.some((i) => i.tag === BRIDGE_IN_TAG)).toBe(false);
    expect(hop.routingRules.some(isBridgeRule)).toBe(false);
    expect(bridgeSocksPortFromInbounds(hop.inbounds)).toBeNull();
  });

  it('emits a loopback socks inbound and the rule that steers it', () => {
    const hop = buildTopologyFragmentsForNode(ENTRY, {
      ...oneDirection,
      bridgeSocksPort: BRIDGE_SOCKS_PORT,
    })!;

    const inbound = hop.inbounds.find((i) => i.tag === BRIDGE_IN_TAG);
    expect(inbound).toBeDefined();
    // Loopback ONLY: on 0.0.0.0 this is an open unauthenticated socks proxy on
    // a public address.
    expect(inbound!.listen).toBe('127.0.0.1');
    expect(inbound!.port).toBe(BRIDGE_SOCKS_PORT);
    expect(inbound!.protocol).toBe('socks');
    // UDP ASSOCIATE, or a TUIC client loses every QUIC and DNS flow.
    expect(inbound!.settings).toMatchObject({ udp: true });
    // Without sniffing a flow handed over as an IP misses every domain rule in
    // the geo split, and ru-split silently stops applying to this channel.
    expect(inbound!.sniffing).toMatchObject({ enabled: true });

    const rule = hop.routingRules.find(isBridgeRule);
    expect(rule).toBeDefined();
    // The single direction's way out - the same target the tagged clients get.
    expect(rule!.outboundTag).toBe('cascade-link-out-d1-0');

    expect(bridgeSocksPortFromInbounds(hop.inbounds)).toBe(BRIDGE_SOCKS_PORT);
  });

  it('refuses to guess when the entry has more than one direction', () => {
    const hop = buildTopologyFragmentsForNode(ENTRY, {
      ...twoDirections,
      bridgeSocksPort: BRIDGE_SOCKS_PORT,
    })!;
    // A bridged client picks no subscription line, so it cannot say which way
    // out it wants. Emitting nothing leaves the protocol as it is today rather
    // than choosing a country on the buyer's behalf.
    expect(hop.inbounds.some((i) => i.tag === BRIDGE_IN_TAG)).toBe(false);
    expect(hop.routingRules.some(isBridgeRule)).toBe(false);
  });

  it('never emits the inbound without the rule, in any shape', () => {
    // The pair is what makes the bridge safe: an inbound with no rule runs to
    // the entry's terminal refusal and the channel dies; a rule with no inbound
    // matches nothing. Neither half may appear alone.
    for (const input of [oneDirection, twoDirections]) {
      for (const port of [undefined, BRIDGE_SOCKS_PORT]) {
        const hop = buildTopologyFragmentsForNode(ENTRY, { ...input, bridgeSocksPort: port })!;
        const hasInbound = hop.inbounds.some((i) => i.tag === BRIDGE_IN_TAG);
        const hasRule = hop.routingRules.some(isBridgeRule);
        expect(hasInbound).toBe(hasRule);
      }
    }
  });

  it('puts the rule below the geo split and above the terminal refusal', () => {
    const hop = buildTopologyFragmentsForNode(ENTRY, {
      ...oneDirection,
      bridgeSocksPort: BRIDGE_SOCKS_PORT,
      egressPolicies: new Map([[ENTRY, [{ geosite: ['category-ru'], target: 'direct' as const }]]]),
    })!;
    const rules = hop.routingRules;
    const split = rules.findIndex((r) => Array.isArray(r.domain) || Array.isArray(r.geosite));
    const bridge = rules.findIndex(isBridgeRule);
    const terminal = rules.findIndex(
      (r) => r.outboundTag === 'blocked' && r.network === 'tcp,udp' && r.vlessRoute === undefined,
    );

    expect(split).toBeGreaterThanOrEqual(0);
    expect(bridge).toBeGreaterThanOrEqual(0);
    expect(terminal).toBeGreaterThanOrEqual(0);
    // Below the split: a bridged buyer's Russian traffic must still leave
    // directly from the entry, which is the whole product behaviour here.
    expect(bridge).toBeGreaterThan(split);
    // Above the refusal, or the channel is blackholed.
    expect(bridge).toBeLessThan(terminal);
  });

  it('is entry-only: an exit has nowhere to send bridged traffic', () => {
    const hop = buildTopologyFragmentsForNode(EXIT_A, {
      ...oneDirection,
      bridgeSocksPort: BRIDGE_SOCKS_PORT,
    })!;
    expect(hop.inbounds.some((i) => i.tag === BRIDGE_IN_TAG)).toBe(false);
    expect(hop.routingRules.some(isBridgeRule)).toBe(false);
  });
});
