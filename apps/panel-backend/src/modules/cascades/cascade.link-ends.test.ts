import { describe, expect, it } from 'vitest';
import {
  buildTopologyFragmentsForNode,
  generateTopologyLinks,
  parseLinkCred,
  serializeLinkCred,
} from './cascade.config.js';

/**
 * The two ends of an inter-hop link have to agree, and right now they agree by
 * both being plain.
 *
 * `generateTopologyLinks` mints a REALITY keypair, serverName and dest for every
 * vless link; `vlessLinkOutbound` renders them; `parseLinkCred` has a careful
 * comment about accepting the block "only whole". None of it reaches a node:
 * `serializeLinkCred` persists `{protocol, port, uuid}` and drops the rest, so
 * what comes back out of the database never carries reality. The camouflage is
 * generated, documented, and thrown away on save.
 *
 * Measured on xray 26.3.27 rather than argued about, with the fragments this
 * module produces: with the stored (round-tripped) cred both ends render
 * `security: none`, the link is accepted and traffic flows - 559 bytes through
 * `socks-in -> cascade-link-out -> cascade-link-in -> direct`. Handed the
 * pre-persistence cred instead, the receiver still says `none` while the dialer
 * speaks REALITY, and the server rejects every connection with
 * `proxy/vless/encoding: invalid request version` - the TLS bytes read as a
 * plain VLESS header.
 *
 * That second measurement is the reason this file exists. Reviving the
 * camouflage looks like a one-line change to `serializeLinkCred`, and that one
 * line on its own takes every cascade down: `multiClientLinkInbound` hardcodes
 * `security: none` and gives its clients no flow, so the dialer would start
 * speaking REALITY+Vision to a receiver that speaks neither. Three things have
 * to move together - persistence, the receiver, and the fact that one inbound
 * carries one REALITY private key while today every link mints its own.
 */

const N = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ENTRY = N(1);
const EXIT = N(3);

/** Both ends of one link, built the way production builds them: the cred goes
 *  through the database round trip first. */
function endsOfALink(cred: unknown) {
  const topo = {
    positions: [{ position: 0, nodeIds: [ENTRY] }],
    directions: [{ tag: 1, nodeIds: [EXIT] }],
    links: [{ fromNodeId: ENTRY, toNodeId: EXIT, directionTag: 1, cred }],
    hosts: new Map([
      [ENTRY, '127.0.0.1'],
      [EXIT, '127.0.0.1'],
    ]),
    policies: [],
  } as never;
  const entry = buildTopologyFragmentsForNode(ENTRY, topo);
  const exit = buildTopologyFragmentsForNode(EXIT, topo);
  const dialer = (entry?.outbounds ?? []).find((o) =>
    String((o as { tag?: string }).tag ?? '').startsWith('cascade-link-out'),
  ) as Record<string, never> | undefined;
  const receiver = (exit?.inbounds ?? [])[0] as Record<string, never> | undefined;
  const read = (o: Record<string, never> | undefined) =>
    ((o?.['streamSettings'] ?? {}) as { security?: string }).security ?? 'none';
  const dialerFlow =
    (
      (dialer?.['settings'] as { vnext?: { users?: { flow?: string }[] }[] } | undefined)
        ?.vnext?.[0]?.users?.[0] ?? {}
    ).flow ?? '';
  const receiverFlow =
    (
      (receiver?.['settings'] as { clients?: { flow?: string }[] } | undefined)?.clients?.[0] ?? {}
    ).flow ?? '';
  return {
    dialerSecurity: read(dialer),
    receiverSecurity: read(receiver),
    dialerFlow,
    receiverFlow,
  };
}

/** A vless link cred exactly as production stores and reloads it. */
function storedCred() {
  const link = generateTopologyLinks(
    [{ nodeIds: [ENTRY] }],
    [{ tag: 1, nodeIds: [EXIT] }],
  ).find((l) => l.cred.protocol === 'vless');
  expect(link, 'generateTopologyLinks produced no vless link').toBeDefined();
  return parseLinkCred(serializeLinkCred(link!.cred));
}

describe('the two ends of an inter-hop link', () => {
  it('agree on the security layer, whatever it is', () => {
    // The guard, and the only assertion here that has to keep holding. It says
    // nothing about WHICH layer - reviving the camouflage is welcome - only that
    // one end cannot get it without the other. Persisting the reality block on
    // its own trips exactly this.
    const ends = endsOfALink(storedCred());
    expect(ends.receiverSecurity, 'the dialer and the receiver speak different protocols').toBe(
      ends.dialerSecurity,
    );
    // And which layer, not just that they match: agreeing on `none` would
    // satisfy the line above while the camouflage had quietly gone dead again.
    expect(ends.dialerSecurity, 'the inter-hop leg lost its camouflage').toBe('reality');
  });

  it('agree on the flow, because VLESS negotiates it per user', () => {
    // Same shape one layer in: a receiver whose client carries no flow rejects a
    // dialer that sends one, with "client flow is empty". The v3 builder said so
    // in a comment and got it right; the v4 rewrite to a multi-client inbound
    // dropped both halves at once.
    const ends = endsOfALink(storedCred());
    expect(ends.receiverFlow).toBe(ends.dialerFlow);
    expect(ends.dialerFlow, 'Vision stopped being negotiated on the leg').toBe('xtls-rprx-vision');
  });

  it('carries the camouflage through persistence', () => {
    // This case used to record the opposite - that the block was minted and
    // then dropped on save - and said it would start failing the day somebody
    // made it survive. That day is this commit, and the two assertions above
    // are what checked the job was finished rather than half done.
    const [fresh] = generateTopologyLinks([{ nodeIds: [ENTRY] }], [{ tag: 1, nodeIds: [EXIT] }]);
    const stored = serializeLinkCred(fresh!.cred);
    expect(Object.keys(stored).sort()).toEqual(['port', 'protocol', 'reality', 'uuid']);

    const back = parseLinkCred(stored) as { reality?: Record<string, string> } | null;
    expect(back?.reality?.privateKey, 'the reality block did not survive the round trip').toBeTruthy();
    expect(back?.reality?.publicKey).toBe(
      (fresh!.cred as { reality?: Record<string, string> }).reality?.publicKey,
    );
  });

  it('gives every link into one node the SAME keypair, and its own shortId', () => {
    // The constraint that makes a receiving inbound possible at all: it carries
    // exactly one `privateKey`, while the port is shared per receiving step, so
    // N directions land on one inbound. A keypair per LINK - which is what this
    // minted before - could never have been served: the inbound would decrypt
    // for one dialler and reject its siblings.
    //
    // `shortIds` is a list, so that is where the per-link secret goes.
    const links = generateTopologyLinks(
      [{ nodeIds: [ENTRY] }],
      [
        { tag: 1, nodeIds: [EXIT] },
        { tag: 2, nodeIds: [EXIT] },
      ],
    ).filter((l) => l.toNodeId === EXIT);
    expect(links.length, 'the fixture produced no sibling links to compare').toBeGreaterThan(1);

    const reality = (l: (typeof links)[number]) =>
      (l.cred as { reality?: Record<string, string> }).reality!;
    const keys = new Set(links.map((l) => reality(l).privateKey));
    expect(keys.size, 'sibling links into one node cannot share an inbound').toBe(1);
    const shortIds = new Set(links.map((l) => reality(l).shortId));
    expect(shortIds.size, 'the per-link secret collapsed into one').toBe(links.length);
  });

  it('gives DIFFERENT receiving nodes different keypairs', () => {
    // The control for the case above. Sharing one identity fleet-wide would
    // satisfy it just as well, and would mean a single compromised node can
    // impersonate every hop.
    const OTHER = N(4);
    const links = generateTopologyLinks(
      [{ nodeIds: [ENTRY] }],
      [
        { tag: 1, nodeIds: [EXIT] },
        { tag: 2, nodeIds: [OTHER] },
      ],
    );
    const keyFor = (node: string) =>
      (
        links.find((l) => l.toNodeId === node)!.cred as { reality?: Record<string, string> }
      ).reality!.privateKey;
    expect(keyFor(EXIT)).not.toBe(keyFor(OTHER));
  });
});
