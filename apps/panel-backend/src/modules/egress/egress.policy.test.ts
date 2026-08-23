import { describe, expect, it } from 'vitest';
import {
  coerceEgressPolicy,
  compileEgressPolicy,
  EgressPolicySchema,
  type EgressPolicy,
} from './egress.policy.js';

const NO_CHANNELS = { warp: false };
const WITH_WARP = { warp: true };

describe('EgressPolicySchema', () => {
  it('rejects a rule with no matcher', () => {
    expect(EgressPolicySchema.safeParse([{ target: 'direct' }]).success).toBe(false);
  });

  it('accepts a rule matching on any single dimension', () => {
    for (const matcher of [
      { geosite: ['ru'] },
      { geoip: ['ru'] },
      { domain: ['example.com'] },
      { ip: ['10.0.0.0/8'] },
      { port: '443' },
    ]) {
      expect(EgressPolicySchema.safeParse([{ ...matcher, target: 'direct' }]).success).toBe(true);
    }
  });

  it('rejects an unknown target', () => {
    expect(
      EgressPolicySchema.safeParse([{ geosite: ['ru'], target: 'zapret2' }]).success,
    ).toBe(false);
  });

  it('rejects an unknown key rather than silently dropping it', () => {
    expect(
      EgressPolicySchema.safeParse([{ geosite: ['ru'], target: 'direct', prot: 'tcp' }]).success,
    ).toBe(false);
  });
});

describe('coerceEgressPolicy', () => {
  it('reads an absent or empty policy as none', () => {
    expect(coerceEgressPolicy(null)).toBeUndefined();
    expect(coerceEgressPolicy(undefined)).toBeUndefined();
    expect(coerceEgressPolicy([])).toBeUndefined();
  });

  // A policy that drifted out of shape compiles to nothing, so the node keeps
  // routing as it did instead of getting half a split it cannot be told about.
  it('reads a malformed policy as none', () => {
    expect(coerceEgressPolicy([{ target: 'direct' }])).toBeUndefined();
    expect(coerceEgressPolicy('nonsense')).toBeUndefined();
  });
});

describe('compileEgressPolicy', () => {
  it('compiles nothing when there is no policy', () => {
    expect(compileEgressPolicy(undefined, NO_CHANNELS)).toEqual({ fragments: null, dropped: [] });
  });

  it('qualifies bare category names and leaves qualified ones alone', () => {
    const policy = EgressPolicySchema.parse([
      { geosite: ['youtube', 'ext:custom.dat:vpn'], geoip: ['ru'], target: 'direct' },
    ]) as EgressPolicy;
    const { fragments } = compileEgressPolicy(policy, NO_CHANNELS);
    expect(fragments?.rules[0]).toEqual({
      domain: ['geosite:youtube', 'ext:custom.dat:vpn'],
      ip: ['geoip:ru'],
      outboundTag: 'direct',
    });
  });

  it('merges literal matchers into the same rule', () => {
    const policy = EgressPolicySchema.parse([
      { geosite: ['ru'], domain: ['example.com'], port: '443', network: 'tcp', target: 'block' },
    ]) as EgressPolicy;
    const { fragments } = compileEgressPolicy(policy, NO_CHANNELS);
    expect(fragments?.rules[0]).toEqual({
      domain: ['geosite:ru', 'example.com'],
      port: '443',
      network: 'tcp',
      outboundTag: 'blocked',
    });
  });

  it('preserves the operator order, which is the precedence xray applies', () => {
    const policy = EgressPolicySchema.parse([
      { domain: ['a.example'], target: 'block' },
      { geosite: ['ru'], target: 'direct' },
    ]) as EgressPolicy;
    const { fragments } = compileEgressPolicy(policy, NO_CHANNELS);
    expect(fragments?.rules.map((r) => r.outboundTag)).toEqual(['blocked', 'direct']);
  });

  // The whole reason the policy is compiled per node: a rule may name a way out
  // this machine does not have, and an unknown outboundTag is a config xray
  // refuses to start on.
  it('drops a rule whose target this node cannot serve', () => {
    const policy = EgressPolicySchema.parse([
      { geosite: ['youtube'], target: 'warp' },
      { geosite: ['ru'], target: 'direct' },
    ]) as EgressPolicy;

    const withoutWarp = compileEgressPolicy(policy, NO_CHANNELS);
    expect(withoutWarp.fragments?.rules).toHaveLength(1);
    expect(withoutWarp.fragments?.rules[0].outboundTag).toBe('direct');
    expect(withoutWarp.dropped).toEqual([
      { index: 0, target: 'warp', reason: 'node has no warp egress' },
    ]);

    const withWarp = compileEgressPolicy(policy, WITH_WARP);
    expect(withWarp.dropped).toEqual([]);
    expect(withWarp.fragments?.rules.map((r) => r.outboundTag)).toEqual(['warp', 'direct']);
  });

  it('compiles to nothing when every rule was dropped', () => {
    const policy = EgressPolicySchema.parse([
      { geosite: ['youtube'], target: 'warp' },
    ]) as EgressPolicy;
    const compiled = compileEgressPolicy(policy, NO_CHANNELS);
    expect(compiled.fragments).toBeNull();
    expect(compiled.dropped).toHaveLength(1);
  });

  // An ip/geoip rule cannot fire under IPIfNonMatch on a node whose later rules
  // include a catch-all (cascade or WARP): xray resolves the sniffed domain for
  // a second pass only when NOTHING matched, and the catch-all always matches.
  describe('domainStrategy', () => {
    it('is left alone for a domain-only policy', () => {
      const policy = EgressPolicySchema.parse([
        { geosite: ['ru'], domain: ['example.com'], target: 'direct' },
      ]) as EgressPolicy;
      expect(compileEgressPolicy(policy, NO_CHANNELS).fragments?.domainStrategy).toBeUndefined();
    });

    it('is raised to IPOnDemand as soon as a rule matches on IP', () => {
      for (const matcher of [{ geoip: ['ru'] }, { ip: ['10.0.0.0/8'] }]) {
        const policy = EgressPolicySchema.parse([
          { ...matcher, target: 'direct' },
        ]) as EgressPolicy;
        expect(compileEgressPolicy(policy, NO_CHANNELS).fragments?.domainStrategy).toBe(
          'IPOnDemand',
        );
      }
    });

    it('stays default when the only IP rule was dropped', () => {
      const policy = EgressPolicySchema.parse([
        { geoip: ['ru'], target: 'warp' },
        { geosite: ['ru'], target: 'direct' },
      ]) as EgressPolicy;
      expect(compileEgressPolicy(policy, NO_CHANNELS).fragments?.domainStrategy).toBeUndefined();
    });
  });
});
