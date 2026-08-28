// The parts of a profile config no editor can send back.
//
// `serverPsk` (shadowsocks) and `ssPassword` (shadowtls) are the inner
// shadowsocks server key. No form renders them - showing a secret in an edit
// form is not something the panel does - and both node adapters refuse an
// inbound that arrives without one:
//
//   shadowsocks serverPsk is required
//   shadowtls ssPassword (inner shadowsocks key) is required
//
// Both halves of "the panel mints this one" were missing, and each was measured
// on 2026-08-29 by feeding the bytes the LIVE panel stored into the node's own
// decoder rather than by reading either side:
//
//  - CREATE minted it for shadowsocks and for nothing else, so every shadowtls
//    profile ever created was one no node would accept.
//  - UPDATE replaces `config` wholesale and the editor rebuilds it from the
//    controls it renders, so renaming a shadowsocks profile DELETED its server
//    PSK. The node stops accepting the inbound and every subscription already
//    handed out changes password.
//
// The node form had made this exact decision correctly for its own blob
// ("a node update REPLACES hardening, so building it from the four toggles
// alone [loses the rest]"); the profile form is the neighbour where the same
// decision was never made.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { createProfile, updateProfile } from './profiles.service.js';
import { PANEL_OWNED_CONFIG_KEYS } from './profile-config.js';
import { ssKeyLengthFor } from './ss-helpers.js';
import { PROTOCOL_CONFIG_SCHEMAS } from '../inbounds/inbounds.schemas.js';
import type { CreateProfileInput } from './profiles.schemas.js';

let seq = 0;
const CREATE: Record<string, () => CreateProfileInput> = {
  shadowsocks: () =>
    ({
      protocol: 'shadowsocks',
      name: `ss-secret-${++seq}`,
      enabled: true,
      config: { method: '2022-blake3-aes-256-gcm' },
    }) as CreateProfileInput,
  shadowtls: () =>
    ({
      protocol: 'shadowtls',
      name: `stls-secret-${++seq}`,
      enabled: true,
      config: { handshake: 'www.microsoft.com', ssMethod: '2022-blake3-aes-128-gcm' },
    }) as CreateProfileInput,
};

/** The minted key of a protocol that has one: the entry carrying a generator. */
function mintedSpec(protocol: string) {
  const spec = PANEL_OWNED_CONFIG_KEYS[protocol]!.find((k) => k.mint != null);
  expect(spec, `${protocol} no longer declares a minted key`).toBeDefined();
  return spec!;
}

function keyOf(protocol: string, config: unknown): string | undefined {
  return (config as Record<string, string | undefined>)[mintedSpec(protocol).key];
}

/**
 * A save that does not mention one key — which is what the editor sends, since
 * it has no control that could produce it.
 *
 * Named explicitly rather than derived from PANEL_OWNED_CONFIG_KEYS: building
 * the payload out of the list under test makes the test agree with the list
 * whatever the list says. Measured — dropping `abusePolicy` from the list left
 * this file green until the payload stopped being built from it.
 */
function saveWithout(config: Record<string, unknown>, key: string): unknown {
  const rest = { ...config };
  delete rest[key];
  return rest;
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('the panel-owned keys of a profile config', () => {
  // Read off the map rather than listed here: a protocol that gains a
  // panel-minted key gets these three checks without anyone remembering to.
  it('covers every protocol that mints one', () => {
    const mints = Object.entries(PANEL_OWNED_CONFIG_KEYS)
      .filter(([, keys]) => keys.some((k) => k.mint != null))
      .map(([protocol]) => protocol);
    expect(Object.keys(CREATE).sort()).toEqual(mints.sort());
  });

  for (const protocol of Object.keys(CREATE)) {
    const spec = mintedSpec(protocol);

    it(`${protocol}: is minted at create, at the cipher's key length`, async () => {
      const created = await createProfile(CREATE[protocol]!());
      const minted = keyOf(protocol, created.config);
      expect(minted, `nothing minted ${spec.key}; the node refuses this inbound`).toBeTruthy();
      const method = String((created.config as Record<string, unknown>)[spec.methodKey!]);
      expect(Buffer.from(minted!, 'base64')).toHaveLength(ssKeyLengthFor(method));
      // And what was stored is a config the protocol's own schema accepts.
      const schema = PROTOCOL_CONFIG_SCHEMAS[protocol as keyof typeof PROTOCOL_CONFIG_SCHEMAS];
      expect(schema.safeParse(created.config).success).toBe(true);
    });

    it(`${protocol}: survives a save that does not mention it`, async () => {
      const created = await createProfile(CREATE[protocol]!());
      const before = keyOf(protocol, created.config)!;
      const updated = await updateProfile(created.id, {
        name: `${created.name}-renamed`,
        config: saveWithout(created.config as Record<string, unknown>, spec.key),
      });
      expect(
        keyOf(protocol, updated.config),
        `renaming the profile deleted ${spec.key}`,
      ).toBe(before);
    });

    it(`${protocol}: is re-minted when the cipher changes length`, async () => {
      const created = await createProfile(CREATE[protocol]!());
      const before = keyOf(protocol, created.config)!;
      const wideMethod = '2022-blake3-aes-256-gcm';
      const narrowMethod = '2022-blake3-aes-128-gcm';
      const startedWide = Buffer.from(before, 'base64').length === 32;
      const next = startedWide ? narrowMethod : wideMethod;

      const updated = await updateProfile(created.id, {
        config: {
          ...(saveWithout(created.config as Record<string, unknown>, spec.key) as object),
          [spec.methodKey!]: next,
        },
      });
      const after = keyOf(protocol, updated.config)!;
      // A carried-over key of the wrong length is a key both cores refuse, so
      // the switch has to mint a new one rather than keep the old.
      expect(Buffer.from(after, 'base64')).toHaveLength(ssKeyLengthFor(next));
      expect(after).not.toBe(before);
    });
  }
});

/**
 * The other half of the same list: keys the panel owns but does not generate.
 * They cannot be minted out of nothing, so the only thing that keeps them is
 * the carry — and the carry is what an edit-save was missing.
 */
describe('a panel-owned key with no generator still survives an edit', () => {
  it('shadowsocks: a relaxed anti-abuse policy is not cleared by a rename', async () => {
    const created = await createProfile({
      protocol: 'shadowsocks',
      name: `ss-abuse-${++seq}`,
      enabled: true,
      // The three toggles live in the xray advanced tabs, so on a shadowsocks
      // profile this arrives over the API and no control can send it back.
      config: {
        method: '2022-blake3-aes-256-gcm',
        abusePolicy: { blockTorrent: false, blockSmtp: true, blockDnsHijack: true },
      },
    } as CreateProfileInput);
    expect(created.config).toMatchObject({ abusePolicy: { blockTorrent: false } });

    const updated = await updateProfile(created.id, {
      name: `${created.name}-renamed`,
      config: saveWithout(created.config as Record<string, unknown>, 'abusePolicy'),
    });
    expect(
      updated.config,
      'renaming the profile silently re-enabled a rule the operator had relaxed',
    ).toMatchObject({ abusePolicy: { blockTorrent: false } });
  });

  it('hysteria: the ACME hostname is not cleared by a rename', async () => {
    const created = await createProfile({
      protocol: 'hysteria',
      name: `hy-host-${++seq}`,
      enabled: true,
      config: { hostname: 'hy.example.com', obfsPassword: 'salamander' },
    } as CreateProfileInput);

    const updated = await updateProfile(created.id, {
      name: `${created.name}-renamed`,
      config: saveWithout(created.config as Record<string, unknown>, 'hostname'),
    });
    // The sync queue rewrites this on every push to a node dialled by name; on
    // an IP-addressed node acmeHostnameFor() returns null and the profile's own
    // value is what the node gets.
    expect(updated.config).toMatchObject({ hostname: 'hy.example.com' });
  });
});
