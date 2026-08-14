import { describe, expect, it } from 'vitest';
import { versionAtLeast, MIN_XRAY_VLESSROUTE } from './cascade.service.js';

// T7: the dotted-version comparison behind the balancer-entry core gate.
describe('versionAtLeast', () => {
  it('accepts equal and newer versions', () => {
    expect(versionAtLeast('25.9.5', '25.9.5')).toBe(true);
    expect(versionAtLeast('25.9.6', '25.9.5')).toBe(true);
    expect(versionAtLeast('25.10.0', '25.9.5')).toBe(true);
    expect(versionAtLeast('26.3.27', '25.9.5')).toBe(true);
    expect(versionAtLeast('100.0.0', '25.9.5')).toBe(true);
  });

  it('rejects older versions', () => {
    expect(versionAtLeast('25.9.4', '25.9.5')).toBe(false);
    expect(versionAtLeast('25.8.99', '25.9.5')).toBe(false);
    expect(versionAtLeast('24.12.31', '25.9.5')).toBe(false);
    expect(versionAtLeast('1.8.4', '25.9.5')).toBe(false);
  });

  it('compares numerically, not lexicographically', () => {
    // "9" > "10" lexicographically but 9 < 10 numerically.
    expect(versionAtLeast('25.10.0', '25.9.0')).toBe(true);
    expect(versionAtLeast('25.9.0', '25.10.0')).toBe(false);
  });

  it('treats missing trailing parts as zero', () => {
    expect(versionAtLeast('26', '25.9.5')).toBe(true);
    expect(versionAtLeast('25.9', '25.9.5')).toBe(false); // 25.9.0 < 25.9.5
    expect(versionAtLeast('25.9.5', '25.9')).toBe(true); // 25.9.5 >= 25.9.0
  });

  it('the configured minimum is the field-verified 25.9.5', () => {
    expect(MIN_XRAY_VLESSROUTE).toBe('25.9.5');
  });
});
