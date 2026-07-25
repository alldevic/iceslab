import { describe, expect, it } from 'vitest';
import {
  validateEgressCategories,
  assertEgressCategories,
  EgressCategoryError,
} from './cascade.geo.stock.js';
import type { EgressPolicy } from './cascade.geo.js';

describe('validateEgressCategories (§3.2)', () => {
  it('accepts standard bare/qualified geosite and known geoip categories', () => {
    const policy: EgressPolicy = [
      { geosite: ['youtube', 'geosite:category-ads-all'], target: 'block' },
      { geoip: ['ru', 'geoip:cn', 'private'], target: 'direct' },
    ];
    expect(validateEgressCategories(policy, [])).toEqual([]);
  });

  it('ignores ext: / literal / already-qualified non-standard matchers', () => {
    const policy: EgressPolicy = [
      {
        geosite: ['ext:geo-custom.dat:mycat', 'domain:foo'],
        domain: ['example.com'],
        ip: ['10.0.0.0/8'],
        geoip: ['ext:geo-custom-ip.dat:ru-extra'],
        target: 'direct',
      },
    ];
    expect(validateEgressCategories(policy, ['mycat', 'ru-extra'])).toEqual([]);
  });

  it('accepts a negated geoip matcher (!cn = everything except CN)', () => {
    expect(validateEgressCategories([{ geoip: ['!cn'], target: 'direct' }], [])).toEqual([]);
    expect(validateEgressCategories([{ geoip: ['geoip:!ru'], target: 'direct' }], [])).toEqual([]);
  });

  it('still rejects a negated UNKNOWN geoip category', () => {
    const issues = validateEgressCategories([{ geoip: ['!rus'], target: 'direct' }], []);
    expect(issues).toHaveLength(1);
  });

  it('rejects an unknown geoip category (typo) fail-closed', () => {
    const policy: EgressPolicy = [{ geoip: ['rus'], target: 'direct' }];
    const issues = validateEgressCategories(policy, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.matcher).toBe('rus');
    expect(issues[0]!.reason).toMatch(/not a known country code/);
  });

  it('does NOT existence-check bare geosite (large open vocab, left to node -test)', () => {
    // A non-stock-looking geosite name is allowed through here; the node's
    // xray -test preflight is authoritative for the actual bundle.
    const policy: EgressPolicy = [{ geosite: ['some-exotic-service'], target: 'link-out' }];
    expect(validateEgressCategories(policy, [])).toEqual([]);
  });

  it('flags a custom category used as a bare geosite: (the mis-routing footgun)', () => {
    const policy: EgressPolicy = [{ geosite: ['runet'], target: 'direct' }];
    const issues = validateEgressCategories(policy, ['runet']);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reason).toMatch(/custom category/);
    expect(issues[0]!.reason).toContain('ext:geo-custom.dat:runet');
  });

  it('flags a custom category used as a bare geoip: too', () => {
    const policy: EgressPolicy = [{ geoip: ['myasn'], target: 'block' }];
    const issues = validateEgressCategories(policy, ['myasn']);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reason).toContain('ext:geo-custom-ip.dat:myasn');
  });

  it('flags a NEGATED custom category (leading ! must not bypass the check)', () => {
    // '!runet' references the custom 'runet' category; the negation must not slip
    // it past the friendly guard (it would be a bare geosite the node can't resolve).
    const gs = validateEgressCategories([{ geosite: ['!runet'], target: 'link-out' }], ['runet']);
    expect(gs).toHaveLength(1);
    expect(gs[0]!.reason).toContain('custom category');
    const gi = validateEgressCategories([{ geoip: ['!myasn'], target: 'block' }], ['myasn']);
    expect(gi).toHaveLength(1);
    expect(gi[0]!.reason).toContain('custom category');
    // The suggested ext ref keeps the negation (geoip reverse-match), so copying
    // it does not silently invert the operator's "everything except" intent.
    expect(gi[0]!.reason).toContain('ext:geo-custom-ip.dat:!myasn');
  });

  it('rejects a malformed category token (whitespace / control chars)', () => {
    const policy: EgressPolicy = [{ geosite: ['you tube'], target: 'direct' }];
    const issues = validateEgressCategories(policy, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reason).toMatch(/not a valid geosite category name/);
  });

  it('is case-insensitive for geoip codes and custom names', () => {
    expect(validateEgressCategories([{ geoip: ['RU'], target: 'direct' }], [])).toEqual([]);
    const issues = validateEgressCategories([{ geosite: ['Runet'], target: 'direct' }], ['runet']);
    expect(issues).toHaveLength(1);
  });
});

describe('assertEgressCategories', () => {
  it('is a no-op for an absent/clean policy', () => {
    expect(() => assertEgressCategories(undefined, [])).not.toThrow();
    expect(() => assertEgressCategories([{ geosite: ['youtube'], target: 'direct' }], [])).not.toThrow();
  });

  it('throws EgressCategoryError listing the offending matchers', () => {
    const policy: EgressPolicy = [{ geoip: ['rus'], target: 'direct' }];
    expect(() => assertEgressCategories(policy, [])).toThrow(EgressCategoryError);
    try {
      assertEgressCategories(policy, []);
    } catch (e) {
      expect((e as EgressCategoryError).issues).toHaveLength(1);
      expect((e as Error).message).toContain('rus');
    }
  });
});
