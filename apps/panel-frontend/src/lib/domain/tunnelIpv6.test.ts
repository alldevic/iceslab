import { describe, expect, it } from 'vitest';
import type { NodeCores } from '@iceslab/shared';
import { tunnelIpv6Gap } from '@/lib/domain/tunnelIpv6';

const cores = (over: { global?: boolean; awgIpv6?: boolean | undefined; noIpv6?: boolean } = {}): NodeCores =>
  ({
    observedAt: 'x',
    ...(over.noIpv6 ? {} : { ipv6: { stack: true, global: over.global ?? true, addresses: [] } }),
    cores: [{ name: 'amneziawg', engine: 'amneziawg', ...(over.awgIpv6 === undefined ? {} : { awgIpv6: over.awgIpv6 }) }],
  }) as unknown as NodeCores;

const awg = { protocol: 'amneziawg', config: { subnet6: 'fd12:3456:789a:1::/64' } };

describe('tunnelIpv6Gap: a profile with subnet6 on a node that will not carry it (18.9)', () => {
  it('a node with the facts carries it: no mark', () => {
    expect(tunnelIpv6Gap(awg, { cores: cores({ awgIpv6: true }) })).toBeNull();
    expect(tunnelIpv6Gap({ protocol: 'wireguard', config: awg.config }, { cores: cores({ awgIpv6: true }), ipv6Mode: 'on' })).toBeNull();
  });

  it('names the first fact that fails: mode off, no global address, an agent that does not say', () => {
    expect(tunnelIpv6Gap(awg, { cores: cores({ awgIpv6: true }), ipv6Mode: 'off' })).toBe('off');
    expect(tunnelIpv6Gap(awg, { cores: cores({ awgIpv6: true, global: false }) })).toBe('address');
    expect(tunnelIpv6Gap(awg, { cores: cores({ awgIpv6: true, noIpv6: true }) })).toBe('address');
    expect(tunnelIpv6Gap(awg, { cores: null })).toBe('address');
    expect(tunnelIpv6Gap(awg, { cores: cores({}) })).toBe('agent');
    expect(tunnelIpv6Gap(awg, { cores: cores({ awgIpv6: false }) })).toBe('agent');
  });

  it('a profile without subnet6, or of another protocol, is never marked', () => {
    expect(tunnelIpv6Gap({ protocol: 'amneziawg', config: { subnet: '10.0.0.0/24' } }, { cores: cores() })).toBeNull();
    expect(tunnelIpv6Gap({ protocol: 'amneziawg', config: { subnet6: '' } }, { cores: cores() })).toBeNull();
    expect(tunnelIpv6Gap({ protocol: 'xray', config: awg.config }, { cores: cores() })).toBeNull();
    expect(tunnelIpv6Gap(undefined, { cores: cores() })).toBeNull();
  });
});
