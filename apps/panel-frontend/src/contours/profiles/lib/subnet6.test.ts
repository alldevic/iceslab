import { describe, expect, it } from 'vitest';
import { randomSubnet6, SUBNET6_RE, subnet6Problem } from '@/contours/profiles/lib/subnet6';
import { defaults } from '@/contours/profiles/lib/profileDefaults';
import { profileConfigOf } from '@/contours/profiles/lib/profileConfig';
import type { Profile } from '@/lib/domain/profiles';

describe('subnet6 of the tunnel (18.9)', () => {
  it('empty is fine, a ULA /64 is fine, anything else is a problem', () => {
    expect(subnet6Problem('')).toBe(false);
    expect(subnet6Problem('  ')).toBe(false);
    expect(subnet6Problem('fd12:3456:789a:1::/64')).toBe(false);
    expect(subnet6Problem(' fd12:3456:789a:1::/64 ')).toBe(false);
    for (const bad of ['2001:db8:1:2::/64', 'fd12:3456:789a:1::/48', 'fd12:3456:789a::/64', 'fd12:3456:789a:1::1/64', '10.0.0.0/24', 'x']) {
      expect(subnet6Problem(bad), bad).toBe(true);
    }
  });

  it('the button draws a valid ULA /64, a different one each time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const v = randomSubnet6();
      expect(SUBNET6_RE.test(v), v).toBe(true);
      seen.add(v);
    }
    expect(seen.size).toBeGreaterThan(35);
    expect(randomSubnet6(() => Uint8Array.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0x00, 0x01]))).toBe('fd12:3456:789a:1::/64');
  });
});

const profileOf = (protocol: 'amneziawg' | 'wireguard', config: Record<string, unknown>) =>
  ({ id: 'p1', protocol, name: 'p', description: null, enabled: true, engine: null, config }) as unknown as Profile;

describe('subnet6 in the form of a saved profile', () => {
  const awg = { subnet: '10.66.66.0/24', serverPrivateKey: 'a', serverPublicKey: 'b', obfuscation: {} };

  it('a saved profile without one opens with the field empty and saves without the key', () => {
    const form = defaults(profileOf('amneziawg', awg));
    expect(form.awgSubnet6).toBe('');
    expect(profileConfigOf(form)).not.toHaveProperty('subnet6');
    const wg = defaults(profileOf('wireguard', { subnet: '10.77.77.0/24', serverPrivateKey: 'a', serverPublicKey: 'b' }));
    expect(wg.wgSubnet6).toBe('');
    expect(profileConfigOf(wg)).not.toHaveProperty('subnet6');
  });

  it('the field can be filled on a saved profile (edit), and the save carries it; cleared, it is dropped', () => {
    const saved = defaults(profileOf('amneziawg', awg));
    const added = profileConfigOf({ ...saved, awgSubnet6: ' fd12:3456:789a:1::/64 ' });
    expect(added.subnet6).toBe('fd12:3456:789a:1::/64');
    expect(added.subnet).toBe('10.66.66.0/24');
    const withIt = defaults(profileOf('amneziawg', { ...awg, subnet6: 'fd12:3456:789a:1::/64' }));
    expect(withIt.awgSubnet6).toBe('fd12:3456:789a:1::/64');
    expect(profileConfigOf({ ...withIt, awgSubnet6: '' })).not.toHaveProperty('subnet6');

    const wgSaved = defaults(profileOf('wireguard', { subnet: '10.77.77.0/24', serverPrivateKey: 'a', serverPublicKey: 'b' }));
    expect(profileConfigOf({ ...wgSaved, wgSubnet6: 'fd12:3456:789a:2::/64' }).subnet6).toBe('fd12:3456:789a:2::/64');
  });

  it('a new profile starts without one', () => {
    expect(defaults(null).awgSubnet6).toBe('');
    expect(defaults(null).wgSubnet6).toBe('');
  });
});
