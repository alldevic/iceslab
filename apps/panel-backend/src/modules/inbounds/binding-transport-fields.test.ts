import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { fetchEnabledInbounds } from './inbounds.queue.js';
import { createBinding, createProfile } from '../profiles/profiles.service.js';

/**
 * Vision on a transport that cannot carry it, arriving through a binding.
 *
 * Measured on xray 26.3.27 against a real node rather than reasoned about,
 * because §24 left exactly this open - whether `grpc + Vision` merely wastes the
 * option or breaks the connection. Four cases, controls included:
 *
 *   raw  + Vision on both ends        -> traffic flows
 *   grpc + no flow on both ends       -> traffic flows
 *   grpc + Vision on both ends        -> no traffic (the gRPC tunnel dies)
 *   grpc + Vision on the SERVER only  -> no traffic, and the server says why:
 *       "account <uuid> is rejected since the client flow is empty. Note that
 *        the pure TLS proxy has certain TLS in TLS characters."
 *
 * The last one is not hypothetical - it is what this panel produces. Our URI
 * builder has always dropped `flow` for gRPC, so the client half is empty by
 * construction; all that is needed is a server account that still demands it.
 *
 * `stripInapplicableTransportFields` blanks the flow when a PROFILE is saved on
 * gRPC. A binding override never went through it: the transport can be switched
 * per node, the merge is shallow, and `flow` came along from the profile.
 */
let seq = 0;

async function xrayProfileOnRaw() {
  seq += 1;
  return createProfile({
    name: `vision-raw-${seq}`,
    protocol: 'xray',
    config: {
      security: 'reality',
      realityDest: 'www.cloudflare.com:443',
      realityServerNames: ['www.cloudflare.com'],
      realityPrivateKey: 'k'.repeat(43),
      realityPublicKey: 'p'.repeat(43),
      realityShortIds: ['0123abcd'],
      network: 'raw',
      flow: 'xtls-rprx-vision',
    },
    enabled: true,
  } as never);
}

async function node(name: string) {
  seq += 1;
  return prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `${name}-${seq}.test:1337`,
      status: 'online',
      heartbeatSecret: Buffer.alloc(32),
    },
  });
}

/** The xray config this node would actually be shipped. */
async function shippedConfig(nodeId: string): Promise<Record<string, unknown>> {
  const inbounds = await fetchEnabledInbounds(nodeId);
  expect(inbounds, 'the node was shipped nothing to serve').toHaveLength(1);
  return inbounds[0]!.config as unknown as Record<string, unknown>;
}

describe('a binding cannot ship Vision on a transport that refuses it', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });
  afterAll(async () => {
    await cleanDatabase();
  });

  it('drops the flow when an override moves the binding to gRPC', async () => {
    const profile = await xrayProfileOnRaw();
    const n = await node('grpc-node');
    await createBinding({
      profileId: profile.id,
      nodeId: n.id,
      port: 443,
      overrides: { network: 'grpc', serviceName: 'gun' },
      enabled: true,
    });

    const cfg = await shippedConfig(n.id);
    expect(cfg['network']).toBe('grpc');
    expect(
      cfg['flow'],
      'the node would demand Vision from clients whose links cannot carry it',
    ).toBe('');
  });

  it('leaves the flow alone on the transport that does carry it', async () => {
    // The control, and it is not decoration: blanking `flow` unconditionally
    // would pass the case above while silently disabling Vision on every raw
    // profile in the fleet - the canonical REALITY setup this panel recommends.
    const profile = await xrayProfileOnRaw();
    const n = await node('raw-node');
    await createBinding({ profileId: profile.id, nodeId: n.id, port: 443, enabled: true });

    const cfg = await shippedConfig(n.id);
    expect(cfg['network']).toBe('raw');
    expect(cfg['flow']).toBe('xtls-rprx-vision');
  });

  it('does not sweep a protocol whose fields it knows nothing about', async () => {
    // The sweep is keyed on xray, and that guard is doing real work even though
    // nothing exercises it today: no other protocol currently owns a field
    // named `path`, `host` or `serviceName`, so removing the guard breaks
    // nothing - right up until one does, and then the sweep starts deleting a
    // field belonging to somebody else's transport.
    //
    // Which is why this asserts the guard rather than the coincidence.
    seq += 1;
    const profile = await createProfile({
      name: `ss-${seq}`,
      protocol: 'shadowsocks',
      config: { method: '2022-blake3-aes-128-gcm' },
      enabled: true,
    } as never);
    const n = await node('ss-node');
    await createBinding({
      profileId: profile.id,
      nodeId: n.id,
      port: 443,
      overrides: { path: '/not-yours' },
      enabled: true,
    });

    const cfg = await shippedConfig(n.id);
    expect(cfg['path'], 'the xray sweep reached into another protocol').toBe('/not-yours');
  });

  it('drops a stale gRPC service name when an override moves the binding to XHTTP', async () => {
    // Same sweep, other direction: a transport field travelling to a node it
    // means nothing on. `serviceName` is the recognisable one - `GunService` is
    // xray's own documented default and reads as a fingerprint from outside.
    //
    // XHTTP and not ws, because ws is not reachable from here: this profile is
    // REALITY, and the write gate refuses that pairing outright before any of
    // this can matter. Two rules meeting on the same field, each doing its own
    // half - worth knowing rather than working around.
    const profile = await xrayProfileOnRaw();
    const n = await node('xhttp-node');
    await createBinding({
      profileId: profile.id,
      nodeId: n.id,
      port: 443,
      overrides: { network: 'xhttp', path: '/dl', serviceName: 'GunService' },
      enabled: true,
    });

    const cfg = await shippedConfig(n.id);
    expect(cfg['network']).toBe('xhttp');
    expect(cfg['serviceName']).toBeUndefined();
    expect(cfg['path']).toBe('/dl');
    // XHTTP does carry Vision, so the flow must SURVIVE this move. The sweep
    // has to be about the transport, not about "any override touching network".
    expect(cfg['flow']).toBe('xtls-rprx-vision');
  });
});
