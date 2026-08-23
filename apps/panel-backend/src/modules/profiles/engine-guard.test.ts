import { describe, expect, it } from 'vitest';
import { CreateProfileSchema, xrayFieldsUnsupportedByEngine } from './profiles.schemas.js';

// The sing-box engine renders a narrow subset of the xray inbound config, and
// anything outside that subset is dropped without a word (see
// xrayFieldsUnsupportedByEngine). These are the fork fields whose silent loss
// would be invisible AND security-relevant, so both halves of the guard (panel
// here, node-agent in singbox/adapter.go) must refuse the pair.
describe('xrayFieldsUnsupportedByEngine', () => {
  it('passes anything on the native xray engine', () => {
    const config = {
      abusePolicy: { blockTorrent: false, blockSmtp: true, blockDnsHijack: true },
      realityMldsa65Seed: 'seed',
      vlessDecryption: 'mlkem768x25519plus.native',
    };
    expect(xrayFieldsUnsupportedByEngine(null, config)).toEqual([]);
    expect(xrayFieldsUnsupportedByEngine('xray', config)).toEqual([]);
  });

  it('passes a plain profile on the sing-box engine', () => {
    expect(xrayFieldsUnsupportedByEngine('singbox', { realityPrivateKey: 'k' })).toEqual([]);
  });

  it('names every unsupported field on the sing-box engine', () => {
    expect(
      xrayFieldsUnsupportedByEngine('singbox', {
        abusePolicy: { blockTorrent: false, blockSmtp: true, blockDnsHijack: true },
        realityMldsa65Seed: 'seed',
        vlessDecryption: 'mlkem768x25519plus.native',
      }),
    ).toEqual(['abusePolicy', 'realityMldsa65Seed', 'vlessDecryption']);
  });

  it('ignores empty post-quantum strings (the schema default)', () => {
    expect(
      xrayFieldsUnsupportedByEngine('singbox', { realityMldsa65Seed: '', vlessDecryption: '' }),
    ).toEqual([]);
  });
});

describe('CreateProfileSchema engine guard', () => {
  const base = { name: 'p1', protocol: 'xray' as const };

  it('rejects an abusePolicy on a sing-box profile', () => {
    const parsed = CreateProfileSchema.safeParse({
      ...base,
      engine: 'singbox',
      config: { realityPrivateKey: 'k', abusePolicy: { blockTorrent: false } },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((i) => i.path.join('.') === 'config.abusePolicy')).toBe(true);
  });

  it('accepts the same profile on the xray engine', () => {
    expect(
      CreateProfileSchema.safeParse({
        ...base,
        engine: 'xray',
        config: { realityPrivateKey: 'k', abusePolicy: { blockTorrent: false } },
      }).success,
    ).toBe(true);
  });
});
