import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import {
  assertBindingFitsNode,
  createBinding,
  createProfile,
  updateBinding,
  updateProfile,
  InvalidBindingConfigError,
} from './profiles.service.js';
import { createHost } from '../hosts/hosts.service.js';

// The gate lives on the profile/binding seam, so every case needs a real row
// on both sides of it: DB-backed. What is asserted is the SERVICE refusing a
// write, not a schema disagreeing with a literal.

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
 * one saved before a rule existed: REALITY over ws. Rows like it did not change
 * when the rule landed, and no migration touches them.
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
    // A REALITY profile, and a binding that quietly moves it to a transport
    // REALITY cannot carry. Nothing about the profile changes; the merge ships.
    const profile = await makeXrayProfile('reality-raw', { security: 'reality' });
    const node = await makeNode('n');

    const err = await createBinding({
      profileId: profile.id,
      nodeId: node.id,
      port: 443,
      overrides: { network: 'ws' },
      enabled: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidBindingConfigError);
    expect((err as InvalidBindingConfigError).code).toBe('INVALID_CONFIG');
    expect((err as InvalidBindingConfigError).issues.join(' ')).toContain('network');

    // A refusal leaves no row for the sync queue to pick up.
    expect(await prisma.profileNodeBinding.count()).toBe(0);
  });

  it('createBinding still accepts overrides the merged config survives', async () => {
    // The control: grpc IS one of REALITY's three transports. Without this the
    // case above would also pass against a gate rejecting every override.
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
    const b = await createBinding({ profileId: profile.id, nodeId: node.id, port: 443, enabled: true });

    await expect(updateBinding(b.id, { overrides: { network: 'kcp' } })).rejects.toThrow(
      InvalidBindingConfigError,
    );
    const row = await prisma.profileNodeBinding.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.overrides).toBeNull();
  });

  it('the host form door (assertBindingFitsNode) judges the overrides it is handed', async () => {
    // createBinding and the host form share this gate; the host move copies a
    // binding's overrides through it.
    const profile = await makeXrayProfile('reality-host', { security: 'reality' });
    const node = await makeNode('n');
    const row = await prisma.profile.findUniqueOrThrow({ where: { id: profile.id } });

    await expect(assertBindingFitsNode(node, row, { network: 'httpupgrade' })).rejects.toThrow(
      InvalidBindingConfigError,
    );
    await expect(assertBindingFitsNode(node, row, { network: 'xhttp' })).resolves.toBeUndefined();
    await expect(assertBindingFitsNode(node, row)).resolves.toBeUndefined();
  });

  it('the host form still creates a host on a profile saved before the rule', async () => {
    // Delta, on the door the form uses: it hands no overrides, so nothing is new.
    const legacy = await makeLegacyBrokenProfile('legacy-host');
    const node = await makeNode('n');
    const host = await createHost({
      profileId: legacy.id,
      nodeId: node.id,
      port: 443,
      remark: 'Default',
    } as never);
    expect(host.id).toBeTruthy();
  });

  it('updateProfile refuses an edit that breaks an existing binding it never mentions', async () => {
    // Both halves are individually fine and neither is the one being edited:
    // the profile starts plain-ws, a binding pins network=ws, then REALITY goes
    // on. The profile alone is valid (reality over the default raw); the
    // deployed merge is reality over ws, which xray refuses to load.
    const profile = await makeXrayProfile('plain-ws', { security: 'none', network: 'ws' });
    const node = await makeNode('bound-node');
    await createBinding({
      profileId: profile.id,
      nodeId: node.id,
      port: 443,
      overrides: { network: 'ws' },
      enabled: true,
    });

    const err = await updateProfile(profile.id, { config: { security: 'reality' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidBindingConfigError);
    // The binding is named by its node.
    expect((err as Error).message).toContain(node.name);

    const after = await prisma.profile.findUniqueOrThrow({ where: { id: profile.id } });
    expect((after.config as { security: string }).security).toBe('none');
  });

  it('updateProfile allows the same edit when no binding contradicts it', async () => {
    // The gate reacts to the pair, not to the word "reality".
    const profile = await makeXrayProfile('plain-ws-ok', { security: 'none', network: 'ws' });
    const node = await makeNode('n');
    await createBinding({ profileId: profile.id, nodeId: node.id, port: 443, enabled: true });

    const updated = await updateProfile(profile.id, { config: { security: 'reality' } });
    expect(updated.id).toBe(profile.id);
  });

  it('a profile already broken before the rule stays editable and bindable', async () => {
    const legacy = await makeLegacyBrokenProfile('legacy');
    const node = await makeNode('n');

    const renamed = await updateProfile(legacy.id, { description: 'still broken, still mine' });
    expect(renamed.description).toBe('still broken, still mine');

    const b = await createBinding({ profileId: legacy.id, nodeId: node.id, port: 443, enabled: true });
    expect(b.id).toBeTruthy();
  });

  it('a binding broken before the rule survives an unrelated edit and a fix', async () => {
    const legacy = await makeLegacyBrokenProfile('legacy-binding');
    const node = await makeNode('n');
    const b = await createBinding({ profileId: legacy.id, nodeId: node.id, port: 443, enabled: true });

    // Unrelated: the port, and an override that breaks nothing new.
    const moved = await updateBinding(b.id, { overrides: { acmeDomain: 'a.example' } });
    expect(moved.id).toBe(b.id);
    // The fix: an override that moves it to a transport REALITY carries.
    const fixed = await updateBinding(b.id, { overrides: { network: 'grpc', serviceName: 'gun' } });
    expect(fixed.id).toBe(b.id);
  });

  it('swapping one already-refused value for another on the same field is allowed', async () => {
    // Fingerprints are (path, code), not (path, message): `network` is already
    // refused as ws, an override moving it to kcp is refused by the same rule,
    // so the request introduced nothing.
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
    // Decides whether "delta" was implemented or just claimed: on a profile
    // whose `network` is already refused, an override introducing an UNRELATED
    // break (a REALITY key in the wrong shape) must still be caught, and named
    // as the new one, not the stale `network` complaint.
    const legacy = await makeLegacyBrokenProfile('legacy-mask');
    const node = await makeNode('n');

    const err = await createBinding({
      profileId: legacy.id,
      nodeId: node.id,
      port: 443,
      overrides: { realityPublicKey: 'not-a-key' },
      enabled: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidBindingConfigError);
    const issues = (err as InvalidBindingConfigError).issues.join(' ');
    expect(issues).toContain('realityPublicKey');
    expect(issues).not.toContain('network');
  });

  it('a vmess profile without a security reads as none, and an override to reality is refused', async () => {
    // The base preprocessing the gate has to share with a save.
    const vmess = await makeXrayProfile('vmess', { subprotocol: 'vmess', network: 'ws' });
    const node = await makeNode('n');
    const ok = await createBinding({ profileId: vmess.id, nodeId: node.id, port: 443, enabled: true });
    expect(ok.id).toBeTruthy();
    await expect(updateBinding(ok.id, { overrides: { security: 'reality' } })).rejects.toThrow(
      InvalidBindingConfigError,
    );
  });
});
