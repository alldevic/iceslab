import { describe, expect, it } from 'vitest';
import { defaults } from '@/contours/profiles/lib/profileDefaults';
import { profileConfigOf } from '@/contours/profiles/lib/profileConfig';
import { WG_SUBNET_RE, wireguardRuleProblems } from '@/contours/profiles/lib/wireguardRules';

const KEY = 'YAT+bEESM0kh2iD3ujUlW1SQ/HeGjigNdYRs8B5ZSEE=';
const form = (over: Partial<ReturnType<typeof defaults>> = {}) => ({
  ...defaults(null),
  protocol: 'wireguard' as const,
  wgServerPriv: KEY,
  wgServerPub: KEY,
  ...over,
});

describe('the plain WireGuard form', () => {
  it('a new profile has a subnet of its own, apart from AmneziaWG\'s, and no keys yet', () => {
    const d = defaults(null);
    expect(d.wgSubnet).toBe('10.77.77.0/24');
    expect(d.wgSubnet).not.toBe(d.awgSubnet);
    expect([d.wgServerPriv, d.wgServerPub]).toEqual(['', '']);
  });

  it('an edit is seeded from the stored config', () => {
    const d = defaults({
      id: 'p', protocol: 'wireguard', name: 'w', description: null, enabled: true, engine: null,
      config: { subnet: '10.9.0.0/24', serverPrivateKey: KEY, serverPublicKey: KEY },
    } as never);
    expect([d.wgSubnet, d.wgServerPriv, d.wgServerPub]).toEqual(['10.9.0.0/24', KEY, KEY]);
  });

  it('the save sends the three keys and no obfuscation member, not even an empty one', () => {
    expect(profileConfigOf(form())).toEqual({ subnet: '10.77.77.0/24', serverPrivateKey: KEY, serverPublicKey: KEY });
  });
});

describe('wireguardRuleProblems', () => {
  it('a good subnet and two keys of the right shape are no problem', () => {
    expect(wireguardRuleProblems(form()).size).toBe(0);
  });

  it('marks the subnet, then each key', () => {
    expect([...wireguardRuleProblems(form({ wgSubnet: '10.77.77.0' }))]).toEqual(['wgSubnet']);
    expect([...wireguardRuleProblems(form({ wgServerPriv: '' }))]).toEqual(['wgServerPriv']);
    expect([...wireguardRuleProblems(form({ wgServerPub: 'a'.repeat(44) }))]).toEqual(['wgServerPub']);
  });

  it('the subnet pattern takes a dotted quad with a prefix and nothing else', () => {
    for (const ok of ['10.77.77.0/24', '192.168.1.0/16']) expect(WG_SUBNET_RE.test(ok), ok).toBe(true);
    for (const bad of ['10.77.77.0', '10.77.77/24', '10.77.77.0/', 'fd00::/64', ' 10.77.77.0/24']) {
      expect(WG_SUBNET_RE.test(bad), bad).toBe(false);
    }
  });
});
