import { describe, expect, it } from 'vitest';
import {
  BRIDGE_IN_TAG,
  BRIDGE_SOCKS_PORT,
  BRIDGE_TPROXY_IN_TAG,
  BRIDGE_TPROXY_PORT,
  bridgeTproxyPortFromInbounds,
  buildTopologyFragmentsForNode,
} from './cascade.config.js';

/**
 * Bridge B (2026-09-02). Same defect as bridge A, one class further down: a
 * WireGuard or AmneziaWG client is served by a KERNEL device, so there is no
 * process to hand its traffic over and no outbound to point anywhere. The
 * node-agent diverts it with TPROXY instead; this file pins the panel's half -
 * the transparent inbound that receives the divert, and the rule that steers
 * what arrives there.
 *
 * The invariants are bridge A's, and deliberately so: emitted together or not
 * at all, below the geo split, entry-only, and never guessing a direction. The
 * one that is new here is that the two bridges stay TOLD APART - they arrive by
 * different means and the inbound tag is the only thing that distinguishes them
 * afterwards.
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

const isTproxyRule = (r: Record<string, unknown>) =>
  Array.isArray(r.inboundTag) && (r.inboundTag as string[]).includes(BRIDGE_TPROXY_IN_TAG);

describe('bridge B: a kernel core joins the cascade through the local xray', () => {
  it('emits nothing at all unless a bridge was asked for', () => {
    const hop = buildTopologyFragmentsForNode(ENTRY, oneDirection)!;
    expect(hop.inbounds.some((i) => i.tag === BRIDGE_TPROXY_IN_TAG)).toBe(false);
    expect(hop.routingRules.some(isTproxyRule)).toBe(false);
    expect(bridgeTproxyPortFromInbounds(hop.inbounds)).toBeNull();
  });

  it('emits a transparent loopback inbound and the rule that steers it', () => {
    const hop = buildTopologyFragmentsForNode(ENTRY, {
      ...oneDirection,
      bridgeTproxyPort: BRIDGE_TPROXY_PORT,
    })!;

    const inbound = hop.inbounds.find((i) => i.tag === BRIDGE_TPROXY_IN_TAG);
    expect(inbound).toBeDefined();
    // Loopback ONLY. A transparent dokodemo-door on a public address relays to
    // any destination its caller names.
    expect(inbound!.listen).toBe('127.0.0.1');
    expect(inbound!.port).toBe(BRIDGE_TPROXY_PORT);
    expect(inbound!.protocol).toBe('dokodemo-door');
    // Both halves of the divert. followRedirect is what reads the original
    // destination back; without it every flow dials this node's own port.
    expect(inbound!.settings).toMatchObject({ followRedirect: true, network: 'tcp,udp' });
    // sockopt.tproxy is what makes the socket transparent at all. Without it
    // the kernel refuses the diverted packet and the tunnel goes quiet.
    expect(inbound!.streamSettings).toMatchObject({ sockopt: { tproxy: 'tproxy' } });
    // A packet out of a tunnel carries an address and no domain. Without
    // sniffing every geosite/domain rule in the split misses, and the channel
    // routes on geoip alone - which is half the split, and the half that sends
    // my.games the wrong way.
    expect(inbound!.sniffing).toMatchObject({ enabled: true });

    const rule = hop.routingRules.find(isTproxyRule);
    expect(rule).toBeDefined();
    expect(rule!.outboundTag).toBe('cascade-link-out-d1-0');

    expect(bridgeTproxyPortFromInbounds(hop.inbounds)).toBe(BRIDGE_TPROXY_PORT);
  });

  it('refuses to guess when the entry has more than one direction', () => {
    const hop = buildTopologyFragmentsForNode(ENTRY, {
      ...twoDirections,
      bridgeTproxyPort: BRIDGE_TPROXY_PORT,
    })!;
    // A wg client picks no subscription line - it has no way to express a
    // choice at all - so with two ways out there is nothing to derive. Emitting
    // nothing leaves the protocol as it is today rather than choosing a country
    // on the buyer's behalf.
    expect(hop.inbounds.some((i) => i.tag === BRIDGE_TPROXY_IN_TAG)).toBe(false);
    expect(hop.routingRules.some(isTproxyRule)).toBe(false);
  });

  it('never emits the inbound without the rule, in any shape', () => {
    for (const input of [oneDirection, twoDirections]) {
      for (const port of [undefined, BRIDGE_TPROXY_PORT]) {
        const hop = buildTopologyFragmentsForNode(ENTRY, { ...input, bridgeTproxyPort: port })!;
        const hasInbound = hop.inbounds.some((i) => i.tag === BRIDGE_TPROXY_IN_TAG);
        const hasRule = hop.routingRules.some(isTproxyRule);
        expect(hasInbound).toBe(hasRule);
      }
    }
  });

  it('puts the rule below the geo split and above the terminal refusal', () => {
    const hop = buildTopologyFragmentsForNode(ENTRY, {
      ...oneDirection,
      bridgeTproxyPort: BRIDGE_TPROXY_PORT,
      egressPolicies: new Map([[ENTRY, [{ geosite: ['category-ru'], target: 'direct' as const }]]]),
    })!;
    const rules = hop.routingRules;
    const split = rules.findIndex((r) => Array.isArray(r.domain) || Array.isArray(r.geosite));
    const bridge = rules.findIndex(isTproxyRule);
    const terminal = rules.findIndex(
      (r) => r.outboundTag === 'blocked' && r.network === 'tcp,udp' && r.vlessRoute === undefined,
    );

    expect(split).toBeGreaterThanOrEqual(0);
    expect(bridge).toBeGreaterThanOrEqual(0);
    expect(terminal).toBeGreaterThanOrEqual(0);
    // Measured on the s1 stand 2026-09-02: yandex.ru and my.games have to leave
    // directly from the entry, api.ipify.org through the link. That ordering is
    // the whole product behaviour of this channel.
    expect(bridge).toBeGreaterThan(split);
    expect(bridge).toBeLessThan(terminal);
  });

  it('is entry-only: an exit has nowhere to send bridged traffic', () => {
    const hop = buildTopologyFragmentsForNode(EXIT_A, {
      ...oneDirection,
      bridgeTproxyPort: BRIDGE_TPROXY_PORT,
    })!;
    expect(hop.inbounds.some((i) => i.tag === BRIDGE_TPROXY_IN_TAG)).toBe(false);
    expect(hop.routingRules.some(isTproxyRule)).toBe(false);
  });

  it('keeps the two bridges apart, and lets a node carry both', () => {
    // The panel has to tell each core which port to use, and the two ports name
    // inbounds of different protocols. One number for both would mean handing a
    // wg interface a socks port, which fails as a dead channel with `ok`
    // reported on every side.
    expect(BRIDGE_TPROXY_PORT).not.toBe(BRIDGE_SOCKS_PORT);
    expect(BRIDGE_TPROXY_IN_TAG).not.toBe(BRIDGE_IN_TAG);

    const hop = buildTopologyFragmentsForNode(ENTRY, {
      ...oneDirection,
      bridgeSocksPort: BRIDGE_SOCKS_PORT,
      bridgeTproxyPort: BRIDGE_TPROXY_PORT,
    })!;
    const socks = hop.inbounds.find((i) => i.tag === BRIDGE_IN_TAG);
    const tproxy = hop.inbounds.find((i) => i.tag === BRIDGE_TPROXY_IN_TAG);
    expect(socks!.protocol).toBe('socks');
    expect(tproxy!.protocol).toBe('dokodemo-door');
    // Both steered, and each read back as itself.
    expect(hop.routingRules.filter(isTproxyRule)).toHaveLength(1);
    expect(bridgeTproxyPortFromInbounds(hop.inbounds)).toBe(BRIDGE_TPROXY_PORT);
  });

  it('one bridge does not drag the other in', () => {
    // s1 carries bridge A today. Turning bridge B on must not be the only way
    // to keep it, and vice versa: the two cores are bound independently.
    const socksOnly = buildTopologyFragmentsForNode(ENTRY, {
      ...oneDirection,
      bridgeSocksPort: BRIDGE_SOCKS_PORT,
    })!;
    expect(socksOnly.inbounds.some((i) => i.tag === BRIDGE_IN_TAG)).toBe(true);
    expect(socksOnly.inbounds.some((i) => i.tag === BRIDGE_TPROXY_IN_TAG)).toBe(false);

    const tproxyOnly = buildTopologyFragmentsForNode(ENTRY, {
      ...oneDirection,
      bridgeTproxyPort: BRIDGE_TPROXY_PORT,
    })!;
    expect(tproxyOnly.inbounds.some((i) => i.tag === BRIDGE_IN_TAG)).toBe(false);
    expect(tproxyOnly.inbounds.some((i) => i.tag === BRIDGE_TPROXY_IN_TAG)).toBe(true);
  });
});
