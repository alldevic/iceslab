import { describe, expect, it } from 'vitest';
import {
  compileEntryGeoRules,
  policyNeedsIpResolution,
  entryDomainStrategy,
  type EgressPolicy,
  type TargetRouting,
} from './cascade.geo.js';

// Chain-entry target map (link-out is a fixed outbound).
const CHAIN: TargetRouting = {
  direct: { outboundTag: 'direct' },
  block: { outboundTag: 'blocked' },
  'link-out': { outboundTag: 'cascade-link-out' },
};

describe('compileEntryGeoRules', () => {
  it('returns no rules for an absent or empty policy', () => {
    expect(compileEntryGeoRules(undefined, CHAIN)).toEqual({ rules: [], needsBlock: false });
    expect(compileEntryGeoRules([], CHAIN)).toEqual({ rules: [], needsBlock: false });
  });

  // xray ANDs the conditions inside one rule; the policy means OR, so a mixed
  // geosite+geoip rule compiles into a domain rule + an ip rule.
  it('prefixes bare category names into xray matchers, splitting a mixed rule (OR)', () => {
    const policy: EgressPolicy = [
      { geosite: ['category-ru', 'category-gov-ru'], geoip: ['ru'], target: 'direct' },
    ];
    const { rules } = compileEntryGeoRules(policy, CHAIN);
    expect(rules).toEqual([
      {
        type: 'field',
        domain: ['geosite:category-ru', 'geosite:category-gov-ru'],
        outboundTag: 'direct',
      },
      { type: 'field', ip: ['geoip:ru'], outboundTag: 'direct' },
    ]);
  });

  it('passes already-qualified matchers through untouched (ext:/geosite:/literals)', () => {
    const policy: EgressPolicy = [
      {
        geosite: ['ext:geo-custom.dat:mycat', 'geosite:youtube'],
        domain: ['example.com', 'domain:foo'],
        ip: ['10.0.0.0/8'],
        target: 'link-out',
      },
    ];
    const { rules } = compileEntryGeoRules(policy, CHAIN);
    expect(rules).toHaveLength(2); // domain rule + ip rule (OR)
    expect(rules[0]).toMatchObject({
      domain: ['ext:geo-custom.dat:mycat', 'geosite:youtube', 'example.com', 'domain:foo'],
      outboundTag: 'cascade-link-out',
    });
    expect(rules[1]).toMatchObject({ ip: ['10.0.0.0/8'], outboundTag: 'cascade-link-out' });
    expect(rules[0]).not.toHaveProperty('ip');
    expect(rules[1]).not.toHaveProperty('domain');
  });

  it('flags needsBlock and maps block -> blackhole tag', () => {
    const policy: EgressPolicy = [{ geosite: ['category-ads-all'], target: 'block' }];
    const { rules, needsBlock } = compileEntryGeoRules(policy, CHAIN);
    expect(needsBlock).toBe(true);
    expect(rules[0]).toEqual({
      type: 'field',
      domain: ['geosite:category-ads-all'],
      outboundTag: 'blocked',
    });
  });

  it('needsBlock stays false when nothing blocks', () => {
    const policy: EgressPolicy = [{ geoip: ['ru'], target: 'direct' }];
    expect(compileEntryGeoRules(policy, CHAIN).needsBlock).toBe(false);
  });

  it('carries port and network matchers', () => {
    const policy: EgressPolicy = [
      { geosite: ['discord'], network: 'udp', port: '443', target: 'direct' },
    ];
    expect(compileEntryGeoRules(policy, CHAIN).rules[0]).toEqual({
      type: 'field',
      domain: ['geosite:discord'],
      network: 'udp',
      port: '443',
      outboundTag: 'direct',
    });
  });

  it('drops a matcherless rule so it cannot shadow the real catch-all', () => {
    const policy: EgressPolicy = [
      { target: 'direct' }, // no geosite/geoip/domain/ip/port -> would be a catch-all
      { geoip: ['ru'], target: 'direct' },
    ];
    const { rules } = compileEntryGeoRules(policy, CHAIN);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.ip).toEqual(['geoip:ru']);
  });

  it('preserves policy order (first-match precedence is the caller contract)', () => {
    const policy: EgressPolicy = [
      { geosite: ['category-ads-all'], target: 'block' },
      { geoip: ['ru'], target: 'direct' },
    ];
    const { rules } = compileEntryGeoRules(policy, CHAIN);
    expect(rules.map((r) => r.outboundTag)).toEqual(['blocked', 'direct']);
  });

  it('routes link-out to a balancerTag on a balancer entry', () => {
    const BALANCER: TargetRouting = {
      direct: { outboundTag: 'direct' },
      block: { outboundTag: 'blocked' },
      'link-out': { balancerTag: 'auto' },
    };
    const policy: EgressPolicy = [{ geoip: ['ru'], target: 'direct' }, { domain: ['x.com'], target: 'link-out' }];
    const { rules } = compileEntryGeoRules(policy, BALANCER);
    expect(rules[1]).toMatchObject({ domain: ['x.com'], balancerTag: 'auto' });
    expect(rules[1]).not.toHaveProperty('outboundTag');
  });
});

describe('policyNeedsIpResolution / entryDomainStrategy (E - §3.1)', () => {
  it('is false (default strategy) for an absent/empty policy', () => {
    expect(policyNeedsIpResolution(undefined)).toBe(false);
    expect(policyNeedsIpResolution([])).toBe(false);
    expect(entryDomainStrategy(undefined)).toBeUndefined();
  });

  it('is false for a geosite/domain-only policy (no IP resolution needed)', () => {
    const policy: EgressPolicy = [
      { geosite: ['category-ru'], target: 'direct' },
      { domain: ['example.com'], target: 'block' },
    ];
    expect(policyNeedsIpResolution(policy)).toBe(false);
    expect(entryDomainStrategy(policy)).toBeUndefined();
  });

  it('is true (IPOnDemand) when any rule has a geoip matcher', () => {
    const policy: EgressPolicy = [{ geoip: ['ru'], target: 'direct' }];
    expect(policyNeedsIpResolution(policy)).toBe(true);
    expect(entryDomainStrategy(policy)).toBe('IPOnDemand');
  });

  it('is true (IPOnDemand) when any rule has a literal ip matcher', () => {
    const policy: EgressPolicy = [
      { geosite: ['youtube'], target: 'link-out' },
      { ip: ['10.0.0.0/8'], target: 'direct' },
    ];
    expect(policyNeedsIpResolution(policy)).toBe(true);
    expect(entryDomainStrategy(policy)).toBe('IPOnDemand');
  });
});
