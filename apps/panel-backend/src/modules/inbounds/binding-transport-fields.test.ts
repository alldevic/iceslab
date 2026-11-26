import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { REALITY_TEST_PRIVATE_KEY, REALITY_TEST_PUBLIC_KEY } from '../../../tests/helpers/reality-keys.js';
import { fetchEnabledInbounds } from './inbounds.queue.js';
import { createBinding, createProfile, resolveBindingConfig } from '../profiles/profiles.service.js';

/**
 * Vision on a transport that cannot carry it, arriving through a binding.
 *
 * Measured on xray 26.3.27 (the fork's rig): `grpc + Vision` on the SERVER only
 * carries no traffic, and the server says why: "account <uuid> is rejected since
 * the client flow is empty". It is what this panel would produce, because the
 * client URI builder drops `flow` for gRPC, so the client half is empty by
 * construction and only a server account still demanding Vision is needed.
 *
 * `stripInapplicableTransportFields` blanks the flow when a PROFILE is saved.
 * A binding override never went through it: the transport can be switched per
 * node, the merge is shallow, and `flow` came along from the profile. The merge
 * (resolveBindingConfig) is now swept the same way, and the sync queue and the
 * subscription both read it.
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
      realityPrivateKey: REALITY_TEST_PRIVATE_KEY,
      realityPublicKey: REALITY_TEST_PUBLIC_KEY,
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
    expect(cfg['flow'], 'the node would demand Vision from clients whose links cannot carry it').toBe('');
  });

  it('leaves the flow alone on the transport that does carry it', async () => {
    // The control: blanking `flow` unconditionally would pass the case above
    // while silently disabling Vision on every raw profile in the fleet.
    const profile = await xrayProfileOnRaw();
    const n = await node('raw-node');
    await createBinding({ profileId: profile.id, nodeId: n.id, port: 443, enabled: true });

    const cfg = await shippedConfig(n.id);
    expect(cfg['network']).toBe('raw');
    expect(cfg['flow']).toBe('xtls-rprx-vision');
  });

  it('does not sweep a protocol whose fields it knows nothing about', async () => {
    // The sweep is keyed on xray: no other protocol owns a field named `path`,
    // `host` or `serviceName` today, so dropping the guard breaks nothing right
    // up until one does. Asserts the guard rather than the coincidence.
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

  it('drops a stale gRPC service name when an override moves the binding to XHTTP, keeping Vision', async () => {
    // XHTTP and not ws: this profile is REALITY, and the write gate refuses that
    // pairing outright. XHTTP does carry Vision, so the flow must SURVIVE the
    // move: the sweep is about the transport, not about "any override on network".
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
    expect(cfg['flow']).toBe('xtls-rprx-vision');
  });

  it('a profile without overrides is what its config says, same object contents', async () => {
    const profile = await xrayProfileOnRaw();
    const n = await node('plain-node');
    await createBinding({ profileId: profile.id, nodeId: n.id, port: 443, enabled: true });
    const row = await prisma.profile.findUniqueOrThrow({ where: { id: profile.id } });

    const merged = resolveBindingConfig(row.config, null, 'xray');
    expect(merged).toEqual(row.config);
    expect(await shippedConfig(n.id)).toMatchObject(merged);
  });

  it('the queue and the subscription read one merge', async () => {
    // Both call resolveBindingConfig; what the node is shipped is exactly the
    // function's answer for the stored rows, so a client link built from the
    // same call cannot disagree with it about the transport or the flow.
    const profile = await xrayProfileOnRaw();
    const n = await node('same-node');
    await createBinding({
      profileId: profile.id,
      nodeId: n.id,
      port: 443,
      overrides: { network: 'grpc', serviceName: 'gun', path: '/stale' },
      enabled: true,
    });
    const b = await prisma.profileNodeBinding.findFirstOrThrow({ where: { nodeId: n.id }, include: { profile: true } });
    const merged = resolveBindingConfig(b.profile.config, b.overrides, b.profile.protocol);
    expect(merged['flow']).toBe('');
    expect(merged['path']).toBeUndefined();
    expect(await shippedConfig(n.id)).toMatchObject(merged);
  });
});
