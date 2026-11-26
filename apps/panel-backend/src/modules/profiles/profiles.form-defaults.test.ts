import { describe, expect, it } from 'vitest';
import { PROTOCOL_NAMES } from '@iceslab/shared';
import { CreateProfileSchema } from './profiles.schemas.js';
import { PROTOCOL_CONFIG_SCHEMAS } from '../inbounds/inbounds.schemas.js';
import { WG_TEST_PRIVATE_KEY, WG_TEST_PUBLIC_KEY } from '../../../tests/helpers/wg-keys.js';
import { REALITY_TEST_PRIVATE_KEY, REALITY_TEST_PUBLIC_KEY } from '../../../tests/helpers/reality-keys.js';
// The profile form's own pure functions, through the frontend's alias (see
// vitest.config.ts). The direction is this one on purpose: the frontend has no
// zod and imports nothing of the backend (CONTRIBUTING.md, "Mirror tests").
import { PROFILE_KINDS } from '@/contours/profiles/lib/profileKinds';
import { defaults } from '@/contours/profiles/lib/profileDefaults';
import { profileConfigOf } from '@/contours/profiles/lib/profileConfig';
import { settleXrayFields } from '@/contours/profiles/lib/xrayFieldReactions';
import type { Profile } from '@/lib/domain/profiles';
import type { FormValues } from '@/contours/profiles/lib/profileFormValues';

/**
 * What a new profile of each kind of the form says when saved untouched, plus
 * what the operator has to type, must be accepted by the API. A default moved
 * on one side, or a bound tightened on the other (the AmneziaWG S3/S4 and the
 * mieru MTU were both this), fails here and not on the operator's first save.
 *
 * Only the inputs the form leaves for the operator are filled in: keys the
 * schema checks the shape of, the naive hostname and email, a name.
 */
const OPERATOR_INPUT: Partial<FormValues> = {
  name: 'new-profile',
  awgServerPriv: WG_TEST_PRIVATE_KEY,
  awgServerPub: WG_TEST_PUBLIC_KEY,
  xrayPrivateKey: REALITY_TEST_PRIVATE_KEY,
  xrayPublicKey: REALITY_TEST_PUBLIC_KEY,
  naiveHostname: 'proxy.example.com',
  naiveTlsEmail: 'ops@example.com',
};

describe('the new-profile defaults of every kind of the form are accepted by the API', () => {
  it('every protocol of the contract has a kind in the form', () => {
    // `wireguard` has no kind until the profile form of 9.3; 9.3 drops this filter.
    expect([...new Set(PROFILE_KINDS.map((k) => k.protocol))].sort()).toEqual(
      PROTOCOL_NAMES.filter((p) => p !== 'wireguard').sort(),
    );
  });

  it('every protocol has a config schema', () => {
    expect(Object.keys(PROTOCOL_CONFIG_SCHEMAS).sort()).toEqual([...PROTOCOL_NAMES].sort());
  });

  for (const kind of PROFILE_KINDS) {
    it(`${kind.key}: defaults + the operator's input pass CreateProfileSchema`, () => {
      const values = settleXrayFields({
        ...defaults(null),
        ...OPERATOR_INPUT,
        protocol: kind.protocol,
        engine: kind.engine,
        xraySubprotocol: kind.subprotocol ?? 'vless',
      });
      const config = profileConfigOf(values);
      const res = CreateProfileSchema.safeParse({
        protocol: kind.protocol,
        name: values.name,
        engine: kind.engine === 'singbox' ? 'singbox' : null,
        config,
      });
      expect(res.success, JSON.stringify(res.success ? [] : res.error.issues)).toBe(true);
    });

    // Form -> API -> form: what the API stores (its normalised output) opens in
    // the form and saves again as the same config. profileConfig.test.ts holds
    // the form half on its own; this is the half that goes through the schema.
    it(`${kind.key}: the stored config reopens in the form and saves as itself`, () => {
      const values = settleXrayFields({
        ...defaults(null),
        ...OPERATOR_INPUT,
        protocol: kind.protocol,
        engine: kind.engine,
        xraySubprotocol: kind.subprotocol ?? 'vless',
      });
      const send = (config: unknown) =>
        CreateProfileSchema.parse({
          protocol: kind.protocol,
          name: 'p',
          engine: kind.engine === 'singbox' ? 'singbox' : null,
          config,
        });
      const stored = send(profileConfigOf(values)).config;
      const reopened = defaults({
        id: 'p1',
        protocol: kind.protocol,
        name: 'p',
        description: null,
        enabled: true,
        engine: kind.engine === 'singbox' ? 'singbox' : null,
        config: stored,
      } as unknown as Profile);
      expect(send(profileConfigOf(reopened)).config).toEqual(stored);
    });
  }
});
