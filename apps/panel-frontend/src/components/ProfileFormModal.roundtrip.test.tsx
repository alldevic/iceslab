import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/render';
import { PROTOCOL_CONFIG_SCHEMAS } from '../../../panel-backend/src/modules/inbounds/inbounds.schemas';
import { normalizeProfileConfigForSave } from '../../../panel-backend/src/modules/profiles/profile-config';
import type { Profile } from '../lib/api';

/**
 * Open a saved profile, change nothing, press Save — and get the same profile
 * back.
 *
 * `ProfileFormModal.defaults.test.tsx` asks whether each kind can be CREATED.
 * Until this file nothing anywhere asked the other direction, and a profile
 * update REPLACES `config`: whatever the form does not rebuild is deleted, by
 * an operator who only wanted to fix a typo in the name. Measured 2026-08-29
 * against the live panel — renaming a shadowsocks profile answered 200 and came
 * back holding `{"method": "…"}`, its `serverPsk` gone, which is a config the
 * node refuses outright.
 *
 * What "the same profile" means is asked of the server, not restated here: the
 * record is built by the very pipeline a save runs
 * (`normalizeProfileConfigForSave`), and the answer is put through the same
 * pipeline with the record as `previous`. So the comparison is literally "what
 * the database would hold after this save" against "what it holds now", and the
 * keys the panel owns and no form draws need no exception list — the pipeline
 * carries them, and if it ever stops, this goes red too.
 */

const WG_PRIV = 'H1skb6gXGFnftS9xrAzHUeNT/gIbGy34a9xq89xQHFM=';
const WG_PUB = 'aP8lgNU9c2vTGSvljeH1JO1qfCWQ6LwdVT92/RBO/FA=';
const RE_PRIV = 'H1skb6gXGFnftS9xrAzHUeNT_gIbGy34a9xq89xQHFM';
const RE_PUB = 'aP8lgNU9c2vTGSvljeH1JO1qfCWQ6LwdVT92_RBO_FA';
/** An ML-DSA-65 verify key is 1952 bytes and the schema decodes to check. */
const MLDSA_VERIFY = Buffer.alloc(1952, 7).toString('base64');

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    listNodes: vi.fn(async () => ({ nodes: [], total: 0, page: 1, limit: 100 })),
    getRecipeRegistry: vi.fn(async () => ({ recipes: [], stale: false })),
    generateInboundKeypair: vi.fn(async () => ({ privateKey: RE_PRIV, publicKey: RE_PUB })),
    generatePqKeys: vi.fn(async () => ({ seed: 'seed', client: 'client' })),
  };
});

import { ProfileFormModal } from './ProfileFormModal';

type Protocol = keyof typeof PROTOCOL_CONFIG_SCHEMAS;

/**
 * One config per protocol with EVERY key of its schema set away from the
 * default, so a key the form forgets shows up as a changed value rather than as
 * a coincidence. Checked against the schema's own key list below, so a key
 * added to the API cannot quietly stay untested here.
 *
 * Values that a gate makes meaningless are set to agree with their gate rather
 * than against it (`tlsRejectUnknownSni` only under `security: 'tls'`,
 * `realityXver` only under REALITY): the form draws those controls only in the
 * mode they apply to, and resetting them on a mode change is the same intent
 * `stripInapplicableTransportFields` already has for transports.
 */
const FIXTURES: Record<Protocol, Record<string, unknown>> = {
  hysteria: {
    hostname: 'hy.example.com',
    obfsPassword: 'salamander-probe',
    pinnedPeerCertSha256: '053871a6284d8fb97f691036aca7489f188c7adec4b0ffa002722f48a7a86f3f',
    masqueradeUrl: 'https://masquerade.example.org/',
    brutalUpMbps: 240,
    brutalDownMbps: 960,
    portHoppingStart: 20000,
    portHoppingEnd: 25000,
  },
  xray: {
    security: 'reality',
    tlsServerName: 'tls.example.com',
    tlsCert: '-----BEGIN CERTIFICATE-----\nprobe\n-----END CERTIFICATE-----',
    tlsKey: '-----BEGIN PRIVATE KEY-----\nprobe\n-----END PRIVATE KEY-----',
    tlsRejectUnknownSni: false,
    realityDest: 'www.amazon.com:443',
    realityServerNames: ['first.example.com', 'second.example.com'],
    realityShortIds: ['6ba85179e30d4fc2', 'ab'],
    realityPrivateKey: RE_PRIV,
    realityPublicKey: RE_PUB,
    realityXver: 2,
    realityMaxTimeDiff: 90000,
    realityMldsa65Seed: 'c2VlZC1mb3ItbWxkc2E2NQ',
    realityMldsa65Verify: MLDSA_VERIFY,
    vlessDecryption: 'mlkem768x25519plus.native.600s.probe-server-half',
    vlessEncryption: 'mlkem768x25519plus.native.1rtt.probe-client-half',
    realityLimitFallbackUploadBytesPerSec: 65536,
    realityLimitFallbackDownloadBytesPerSec: 131072,
    realityMode: 'self-steal',
    realityFallbackUpstream: 'https://real.example.com/',
    flow: 'xtls-rprx-vision',
    fingerprint: 'firefox',
    network: 'xhttp',
    path: '/probe-path',
    host: 'cdn.example.com',
    serviceName: 'ProbeService',
    xhttpMode: 'stream-up',
    xhttpPaddingBytes: '100-1000',
    grpcMultiMode: true,
    subprotocol: 'vless',
    abusePolicy: { blockTorrent: false, blockSmtp: false, blockDnsHijack: true },
  },
  amneziawg: {
    subnet: '10.99.99.0/24',
    serverPrivateKey: WG_PRIV,
    serverPublicKey: WG_PUB,
    obfuscation: {
      jc: 5, jmin: 70, jmax: 140,
      s1: 33, s2: 57, s3: 34, s4: 18,
      h1: 1234567, h2: 2345678, h3: 3456789, h4: 4567890,
      i1: '<b 0xc00000000108><r 64><t>',
      i2: 'aabbcc', i3: 'ddeeff', i4: '001122', i5: '334455',
    },
    // Проверяем на `true`, а не на умолчании: форма, потерявшая контрол,
    // вернула бы `false`, и обход по ключам этого бы не заметил.
    presharedKey: true,
  },
  wireguard: {
    subnet: '10.88.88.0/24',
    serverPrivateKey: WG_PRIV,
    serverPublicKey: WG_PUB,
    presharedKey: true,
  },
  naive: {
    hostname: 'naive.example.com',
    tlsEmail: 'ops@example.com',
    masqueradeRoot: '/srv/www/probe',
  },
  shadowsocks: {
    method: '2022-blake3-chacha20-poly1305',
    serverPsk: Buffer.alloc(32, 3).toString('base64'),
    abusePolicy: { blockTorrent: false, blockSmtp: true, blockDnsHijack: true },
  },
  mtproto: { domain: 'probe.example.com' },
  mieru: { mtu: 1280 },
  tuic: { serverName: 'tuic.example.com', congestionControl: 'new_reno' },
  anytls: { serverName: 'anytls.example.com' },
  shadowtls: {
    handshake: 'probe.example.com',
    ssMethod: '2022-blake3-aes-256-gcm',
    ssPassword: Buffer.alloc(32, 5).toString('base64'),
  },
};

/** The protocol's schema key list, read off the schema rather than listed. */
function schemaKeys(protocol: Protocol): string[] {
  const shape = (PROTOCOL_CONFIG_SCHEMAS[protocol] as unknown as { shape: Record<string, unknown> })
    .shape;
  return Object.keys(shape).sort();
}

function record(protocol: Protocol, engine: string | null): Profile {
  return {
    id: `00000000-0000-4000-8000-0000000000${protocol.length.toString().padStart(2, '0')}`,
    name: 'roundtrip-probe',
    protocol: protocol as Profile['protocol'],
    engine,
    description: 'a profile that already exists',
    // What the database holds: the fixture through the server's save pipeline.
    config: normalizeProfileConfigForSave(protocol, FIXTURES[protocol]) as Profile['config'],
    enabled: true,
    bindingCount: 1,
    userCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

interface Kind {
  label: string;
  protocol: Protocol;
  engine: 'singbox' | null;
}

/** Same fourteen kinds the create-side door runs on. */
const KINDS: Kind[] = [
  { label: 'Xray (native)', protocol: 'xray', engine: null },
  { label: 'Hysteria 2 (native)', protocol: 'hysteria', engine: null },
  { label: 'Shadowsocks 2022 (native)', protocol: 'shadowsocks', engine: null },
  { label: 'AmneziaWG', protocol: 'amneziawg', engine: null },
  { label: 'WireGuard', protocol: 'wireguard', engine: null },
  { label: 'NaiveProxy', protocol: 'naive', engine: null },
  { label: 'MTProto', protocol: 'mtproto', engine: null },
  { label: 'Mieru', protocol: 'mieru', engine: null },
  { label: 'TUIC', protocol: 'tuic', engine: null },
  { label: 'AnyTLS', protocol: 'anytls', engine: null },
  { label: 'ShadowTLS', protocol: 'shadowtls', engine: null },
];

describe('opening a saved profile and pressing Save changes nothing', () => {
  it('every protocol the API has a schema for has a fixture, and it is complete', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(PROTOCOL_CONFIG_SCHEMAS).sort());
    for (const protocol of Object.keys(FIXTURES) as Protocol[]) {
      expect(
        Object.keys(FIXTURES[protocol]).sort(),
        `the ${protocol} fixture no longer names every key of its schema, so a key nobody set is a key nobody checks`,
      ).toEqual(schemaKeys(protocol));
    }
  });

  it('covers every protocol', () => {
    expect([...new Set(KINDS.map((k) => k.protocol))].sort()).toEqual(
      Object.keys(PROTOCOL_CONFIG_SCHEMAS).sort(),
    );
  });

  for (const kind of KINDS) {
    it(`${kind.label}`, async () => {
      const existing = record(kind.protocol, kind.engine);
      const onSubmit = vi.fn(async () => {});
      const { user } = renderWithProviders(
        <ProfileFormModal
          opened
          onClose={() => {}}
          profile={existing}
          onSubmit={onSubmit}
          loading={false}
        />,
      );

      await user.click(await screen.findByRole('button', { name: 'Save' }));
      await waitFor(() => {
        if (onSubmit.mock.calls.length === 1) return;
        const said = Array.from(document.querySelectorAll('.mantine-InputWrapper-error'))
          .map((el) => el.textContent)
          .filter(Boolean);
        throw new Error(
          `the form refused to re-save a profile it had just been handed${said.length ? `: ${said.join(' | ')}` : ' and said nothing about why'}`,
        );
      });

      const payload = (onSubmit.mock.calls as unknown[][])[0][0] as { config: unknown };
      // Through the same pipeline the server runs, with the record as previous:
      // this is what the row would hold after the save.
      const stored = normalizeProfileConfigForSave(kind.protocol, payload.config, existing.config);
      expect(stored, 'pressing Save on an untouched profile changed what is stored').toEqual(
        existing.config,
      );
    });
  }
});
