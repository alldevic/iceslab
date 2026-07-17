import { describe, expect, it } from 'vitest';
import { reconcileEntryGeo } from './cascade.service.js';
import type { EgressPolicy } from './cascade.geo.js';

const BASE = 'https://panel.example/geo/tok';
const META = {
  categories: [
    { name: 'ADS', domains: 42, cidrs: 0 }, // has domains only
    { name: 'RUNET', domains: 0, cidrs: 17 }, // has cidrs only
    { name: 'EMPTY', domains: 0, cidrs: 0 }, // composed to nothing
  ],
  artifacts: [
    { name: 'geo-custom.dat', sha256: 'a'.repeat(64) },
    { name: 'geo-custom-ip.dat', sha256: 'b'.repeat(64) },
    { name: 'geosite.dat', sha256: 'c'.repeat(64) }, // the mirror - must NOT be pushed
  ],
};

describe('reconcileEntryGeo', () => {
  it('keeps standard geosite:/geoip: matchers and pushes NO assets for a standard-only policy', () => {
    const policy: EgressPolicy = [{ geosite: ['category-ru'], geoip: ['ru'], target: 'direct' }];
    const { policy: out, assets } = reconcileEntryGeo(policy, META, BASE);
    expect(out).toEqual(policy); // untouched
    expect(assets).toBeUndefined(); // standard categories resolve from the node bundle
  });

  it('keeps a satisfiable ext: matcher and pushes only the referenced custom .dat (not the mirror)', () => {
    const policy: EgressPolicy = [{ geosite: ['ext:geo-custom.dat:ads'], target: 'block' }];
    const { policy: out, assets } = reconcileEntryGeo(policy, META, BASE);
    expect(out![0]!.geosite).toEqual(['ext:geo-custom.dat:ads']); // kept (ADS has domains)
    expect(assets).toEqual([
      { name: 'geo-custom.dat', url: `${BASE}/geo-custom.dat`, sha256: 'a'.repeat(64) },
    ]);
    // the full mirror geosite.dat is NOT pushed (would overwrite the node's bundle)
    expect(assets!.some((a) => a.name === 'geosite.dat')).toBe(false);
  });

  it('routes an ip-side ext: matcher to geo-custom-ip.dat', () => {
    const policy: EgressPolicy = [{ geoip: ['ext:geo-custom-ip.dat:runet'], target: 'direct' }];
    const { policy: out, assets } = reconcileEntryGeo(policy, META, BASE);
    expect(out![0]!.geoip).toEqual(['ext:geo-custom-ip.dat:runet']);
    expect(assets).toEqual([
      { name: 'geo-custom-ip.dat', url: `${BASE}/geo-custom-ip.dat`, sha256: 'b'.repeat(64) },
    ]);
  });

  it('DROPS a rule whose category composed to zero (would crash-loop xray) and ships no asset', () => {
    const policy: EgressPolicy = [{ geosite: ['ext:geo-custom.dat:empty'], target: 'block' }];
    const { policy: out, assets } = reconcileEntryGeo(policy, META, BASE);
    expect(out).toEqual([]); // its only matcher was stripped -> whole rule dropped
    expect(assets).toBeUndefined(); // nothing to push
  });

  it('STRIPS an ext: matcher for an unknown category, keeping the standard matcher in the same rule', () => {
    const policy: EgressPolicy = [
      { geosite: ['category-ru', 'ext:geo-custom.dat:nope'], target: 'direct' },
    ];
    const { policy: out } = reconcileEntryGeo(policy, META, BASE);
    expect(out![0]!.geosite).toEqual(['category-ru']); // standard kept, dead ext dropped
  });

  it('DROPS custom-ext-only rules when there is no shippable build (meta null = flag off / no build), keeps standard', () => {
    const policy: EgressPolicy = [
      { geosite: ['ext:geo-custom.dat:ads'], target: 'block' },
      { geoip: ['ru'], target: 'direct' },
    ];
    const { policy: out, assets } = reconcileEntryGeo(policy, null, BASE);
    expect(out).toHaveLength(1); // the custom-ext-only rule dropped (can't deliver the file)
    expect(out![0]!.geoip).toEqual(['ru']); // standard survives
    expect(assets).toBeUndefined();
  });

  it('DROPS a rule pointing at an ext file the panel never produces', () => {
    const policy: EgressPolicy = [{ domain: ['ext:evil.dat:x'], target: 'direct' }];
    const { policy: out, assets } = reconcileEntryGeo(policy, META, BASE);
    expect(out).toEqual([]);
    expect(assets).toBeUndefined();
  });

  it('DROPS a rule whose category matcher was stripped even if it carries a port (no port-scoped broadening)', () => {
    // "block MYCAT on 443" must NOT degrade into "block ALL 443" when MYCAT is
    // empty; the rule loses its only matcher, so the whole rule is dropped.
    const policy: EgressPolicy = [
      { geosite: ['ext:geo-custom.dat:empty'], port: '443', target: 'block' },
      { geoip: ['ru'], target: 'direct' },
    ];
    const { policy: out } = reconcileEntryGeo(policy, META, BASE);
    expect(out).toHaveLength(1); // the port-bearing ext rule dropped entirely
    expect(out![0]!.geoip).toEqual(['ru']);
  });

  it('KEEPS an intentional port-only rule (no matchers to begin with)', () => {
    const policy: EgressPolicy = [{ port: '443', network: 'udp', target: 'direct' }];
    const { policy: out } = reconcileEntryGeo(policy, META, BASE);
    expect(out).toEqual(policy); // untouched - the operator meant "all udp/443"
  });

  it('passes an absent/empty policy straight through', () => {
    expect(reconcileEntryGeo(undefined, META, BASE)).toEqual({ policy: undefined, assets: undefined });
    expect(reconcileEntryGeo([], META, BASE)).toEqual({ policy: [], assets: undefined });
  });
});
