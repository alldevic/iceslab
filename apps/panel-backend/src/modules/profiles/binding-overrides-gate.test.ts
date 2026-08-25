import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import {
  createBinding,
  createProfile,
  updateBinding,
  updateProfile,
  InvalidBindingConfigError,
} from './profiles.service.js';

// The gate under test lives on the profile/binding seam, so every case here
// needs a real row on both sides of it - hence DB-backed rather than a unit
// test on the merge helper. What is asserted is the SERVICE refusing a write,
// not a schema disagreeing with a literal.

let seq = 0;

async function makeNode(name: string) {
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

async function makeXrayProfile(name: string, config: Record<string, unknown>) {
  seq += 1;
  return createProfile({
    name: `${name}-${seq}`,
    protocol: 'xray',
    config: config as never,
    enabled: true,
  } as never);
}

/**
 * A profile row written straight past createProfile's schema, standing in for
 * one saved before a rule existed. REALITY over ws is the case that actually
 * happened: profiles carrying it predate the transport check by every commit up
 * to 2b24b06, and their rows did not change when the rule landed.
 */
async function makeLegacyBrokenProfile(name: string) {
  seq += 1;
  return prisma.profile.create({
    data: {
      name: `${name}-${seq}`,
      protocol: 'xray',
      config: { security: 'reality', network: 'ws', path: '/legacy' },
      enabled: true,
    },
  });
}

describe('binding overrides cannot smuggle a config past the protocol schema', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });
  afterAll(async () => {
    await cleanDatabase();
  });

  it('createBinding refuses overrides that break a rule the profile alone satisfies', async () => {
    // Exactly the request that answered 201 on the live panel: a REALITY
    // profile, and a binding that quietly moves it to a transport REALITY
    // cannot carry. Nothing about the profile changes; the merge is what ships.
    const profile = await makeXrayProfile('reality-raw', { security: 'reality' });
    const node = await makeNode('n');

    await expect(
      createBinding({
        profileId: profile.id,
        nodeId: node.id,
        port: 443,
        overrides: { network: 'ws' },
        enabled: true,
      }),
    ).rejects.toThrow(InvalidBindingConfigError);

    // And the refusal is a refusal: no row, so nothing for the sync queue to
    // pick up on the next pass.
    expect(await prisma.profileNodeBinding.count()).toBe(0);
  });

  it('createBinding still accepts overrides the merged config survives', async () => {
    // The control. grpc IS one of REALITY's three transports, so the same shape
    // of request - same profile, same field, a different value - must go
    // through. Without this case the test above would also pass against a gate
    // that simply rejected every override.
    const profile = await makeXrayProfile('reality-raw-ok', { security: 'reality' });
    const node = await makeNode('n');

    const b = await createBinding({
      profileId: profile.id,
      nodeId: node.id,
      port: 443,
      overrides: { network: 'grpc', serviceName: 'gun' },
      enabled: true,
    });
    expect(b.id).toBeTruthy();
  });

  it('updateBinding refuses the same smuggling on an existing binding', async () => {
    const profile = await makeXrayProfile('reality-upd', { security: 'reality' });
    const node = await makeNode('n');
    const b = await createBinding({
      profileId: profile.id,
      nodeId: node.id,
      port: 443,
      enabled: true,
    });

    await expect(updateBinding(b.id, { overrides: { network: 'kcp' } })).rejects.toThrow(
      InvalidBindingConfigError,
    );
    const row = await prisma.profileNodeBinding.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.overrides).toBeNull();
  });

  it('updateProfile refuses an edit that breaks an existing binding it never mentions', async () => {
    // The third door, and the one no per-request check would see: both halves
    // are individually fine and neither is the one being edited. The profile
    // starts plain-ws; a binding pins network=ws (its override wins over
    // whatever the profile says); the operator then turns REALITY on. The
    // profile alone is now valid - reality over the default raw - and the
    // deployed merge is reality over ws, which xray refuses to load.
    const profile = await makeXrayProfile('plain-ws', { security: 'none', network: 'ws' });
    const node = await makeNode('n');
    await createBinding({
      profileId: profile.id,
      nodeId: node.id,
      port: 443,
      overrides: { network: 'ws' },
      enabled: true,
    });

    await expect(
      updateProfile(profile.id, { config: { security: 'reality' } }),
    ).rejects.toThrow(InvalidBindingConfigError);

    const after = await prisma.profile.findUniqueOrThrow({ where: { id: profile.id } });
    expect((after.config as { security: string }).security).toBe('none');
  });

  it('updateProfile allows the same edit when no binding contradicts it', async () => {
    // Same profile, same edit, minus the override that made the merge illegal.
    // The gate must be reacting to the pair, not to the word "reality".
    const profile = await makeXrayProfile('plain-ws-ok', { security: 'none', network: 'ws' });
    const node = await makeNode('n');
    await createBinding({ profileId: profile.id, nodeId: node.id, port: 443, enabled: true });

    const updated = await updateProfile(profile.id, { config: { security: 'reality' } });
    expect(updated.id).toBe(profile.id);
  });

  it('a profile already broken before the rule existed stays editable and bindable', async () => {
    // The delta half of the promise. These rows exist; refusing to touch them
    // would strand the operator with a node in a restart loop and no way to
    // change the profile causing it.
    const legacy = await makeLegacyBrokenProfile('legacy');
    const node = await makeNode('n');

    const renamed = await updateProfile(legacy.id, { description: 'still broken, still mine' });
    expect(renamed.description).toBe('still broken, still mine');

    const b = await createBinding({
      profileId: legacy.id,
      nodeId: node.id,
      port: 443,
      enabled: true,
    });
    expect(b.id).toBeTruthy();
  });

  it('swapping one already-refused value for another on the same field is allowed', async () => {
    // Fingerprints are (path, code), deliberately not (path, message). The
    // profile's `network` is already refused as ws; an override moving it to
    // kcp is refused for the identical reason, so the operator has introduced
    // nothing - the deploy was broken before the request and is broken by the
    // same rule after it. Keyed on the message instead, the two would read as
    // different violations and this request would be blamed for one it did not
    // create.
    const legacy = await makeLegacyBrokenProfile('legacy-swap');
    const node = await makeNode('n');

    const b = await createBinding({
      profileId: legacy.id,
      nodeId: node.id,
      port: 443,
      overrides: { network: 'kcp' },
      enabled: true,
    });
    expect(b.id).toBeTruthy();
  });

  it('a pre-existing violation does not cover for a new one on another field', async () => {
    // The case that decides whether "delta" was implemented or just claimed. On
    // a profile whose `network` is already refused, an override introducing an
    // UNRELATED break - a VLESS-Encryption server half with no client half, so
    // every link the panel emits answers a handshake it cannot do - must still
    // be caught. A gate keyed on "was this config invalid before?" says yes and
    // waves it through; one keyed per (field, rule) does not.
    const legacy = await makeLegacyBrokenProfile('legacy-mask');
    const node = await makeNode('n');

    let err: unknown;
    try {
      await createBinding({
        profileId: legacy.id,
        nodeId: node.id,
        port: 443,
        overrides: { vlessDecryption: 'mlkem768x25519plus.native.600s' },
        enabled: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidBindingConfigError);
    const issues = (err as InvalidBindingConfigError).issues;
    // Named, and named as the NEW one: the stale `network` complaint must not
    // be reported as something this request did.
    expect(issues.join(' ')).toContain('vlessEncryption');
    expect(issues.join(' ')).not.toContain('network');
  });
});
