import { describe, expect, it } from 'vitest';
import { NETWORKS_CARRYING_VISION, REALITY_TRANSPORTS } from '@iceslab/shared';
import { backendSource, exportedConst } from '@/test-support/backendSource';
import { AWG_H_MIN } from '@/contours/profiles/lib/awgHeaders';
import { AWG_S_GAP, WG_KEY_RE } from '@/contours/profiles/lib/awgRules';
import { WG_SUBNET_RE } from '@/contours/profiles/lib/wireguardRules';
import { SUBNET6_RE } from '@/contours/profiles/lib/subnet6';
import { MIERU_MTU } from '@/contours/profiles/lib/mieruMtu';
import {
  FLOW_COMPATIBLE_TRANSPORTS,
  REALITY_COMPATIBLE_TRANSPORTS,
  XRAY_TRANSPORTS,
} from '@/contours/profiles/lib/xrayTransports';

/**
 * The form's rules held to the API's (milestone 6.5; CONTRIBUTING.md, "Mirror
 * tests"). The lists come from @iceslab/shared, the one list both sides import;
 * a number bound is read from the backend source as text, so a bound moved
 * there fails here. What contractCopies.test.ts already holds is not repeated.
 */
const inbounds = backendSource('inbounds/inbounds.schemas.ts');

describe('the transport lists of the form are the API\'s own', () => {
  it('REALITY and Vision read the shared lists, not a copy', () => {
    expect([...REALITY_COMPATIBLE_TRANSPORTS]).toEqual([...REALITY_TRANSPORTS]);
    expect([...FLOW_COMPATIBLE_TRANSPORTS]).toEqual([...NETWORKS_CARRYING_VISION]);
  });

  it('the backend schema takes REALITY_TRANSPORTS from shared too', () => {
    expect(inbounds).toMatch(/import \{[^}]*\bREALITY_TRANSPORTS\b[^}]*\} from '@iceslab\/shared'/);
    expect(inbounds).not.toMatch(/const REALITY_TRANSPORTS\b/);
  });

  it('every transport those lists name is one the form offers', () => {
    const offered = XRAY_TRANSPORTS.map((t) => t.value) as string[];
    for (const n of [...REALITY_TRANSPORTS, ...NETWORKS_CARRYING_VISION]) expect(offered).toContain(n);
  });
});

describe('the mieru MTU of the form against MieruConfigSchema', () => {
  const m = exportedConst(inbounds, 'MieruConfigSchema').match(
    /mtu: z\.number\(\)\.int\(\)\.min\((\d+)\)\.max\((\d+)\)\.default\((\d+)\)/,
  );

  it('the schema still bounds it the way this test reads it', () => {
    expect(m).not.toBeNull();
  });

  it('min, max and the default are the same', () => {
    expect(MIERU_MTU).toEqual({ min: Number(m?.[1]), max: Number(m?.[2]), default: Number(m?.[3]) });
  });
});

describe('the AmneziaWG rules of the form against AmneziawgConfigSchema', () => {
  it('the key shape is the schema\'s pattern', () => {
    const m = inbounds.match(/export const WG_KEY_PATTERN = \/(.+)\/;/);
    expect(m?.[1]).toBe(WG_KEY_RE.source);
  });

  it('H1..H4 start where the schema starts them', () => {
    for (const h of ['h1', 'h2', 'h3', 'h4']) {
      const m = inbounds.match(new RegExp(`${h}: z\\.number\\(\\)\\.int\\(\\)\\.min\\((\\d+)\\)`));
      expect(Number(m?.[1]), h).toBe(AWG_H_MIN);
    }
  });

  it('the two cross-field rules are the schema\'s: S1 + 56 = S2 and Jmin > Jmax', () => {
    expect(inbounds).toContain(`obfuscation.s1 + ${AWG_S_GAP} === obfuscation.s2`);
    expect(inbounds).toContain('obfuscation.jmin > obfuscation.jmax');
  });
});

describe('the plain WireGuard rules of the form against WireguardConfigSchema', () => {
  const schema = exportedConst(inbounds, 'WireguardConfigSchema');

  it('the subnet pattern is the schema\'s', () => {
    const m = schema.match(/subnet: z\.string\(\)\.regex\(\/(.+)\/\)/);
    expect(m?.[1]).toBe(WG_SUBNET_RE.source);
  });

  it('both server keys are checked by the same WgKeySchema as AmneziaWG\'s', () => {
    expect(schema).toContain('serverPrivateKey: WgKeySchema');
    expect(schema).toContain('serverPublicKey: WgKeySchema');
  });

  it('there is no obfuscation member, so the form sends none', () => {
    expect(schema).not.toContain('obfuscation:');
  });
});

describe('the tunnel IPv6 subnet of the form against the backend (18.9)', () => {
  const subnet = backendSource('amneziawg/amneziawg.subnet.ts');

  it('the pattern is the one the schema checks subnet6 with', () => {
    const m = subnet.match(/export const SUBNET6_PATTERN = \/(.+)\/i;/);
    expect(m?.[1]).toBe(SUBNET6_RE.source);
    expect(SUBNET6_RE.flags).toBe('i');
  });

  it('both profile schemas take it as optional, through the one Subnet6Schema', () => {
    expect(exportedConst(inbounds, 'WireguardConfigSchema')).toContain('subnet6: Subnet6Schema.optional()');
    expect(inbounds.match(/subnet6: Subnet6Schema\.optional\(\)/g)).toHaveLength(2);
  });
});
