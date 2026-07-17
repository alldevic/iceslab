import { describe, expect, it } from 'vitest';
import { GeoCategoryInputSchema } from './geo.schemas.js';

describe('GeoCategoryInputSchema name validation', () => {
  it('accepts a safe tag charset and trims surrounding whitespace', () => {
    expect(GeoCategoryInputSchema.parse({ name: '  my-block_1.x  ' }).name).toBe('my-block_1.x');
  });

  it('rejects a name with ":" (breaks the xray ext:geo-custom.dat:<name> tag parse)', () => {
    // ext:geo-custom.dat:ru:gov -> xray splits on ':' into 3 parts -> config load
    // fails -> entry node crash-loops. Must be rejected at authoring time.
    expect(GeoCategoryInputSchema.safeParse({ name: 'ru:gov' }).success).toBe(false);
  });

  it('rejects "@" (xray geosite attribute separator) and spaces', () => {
    expect(GeoCategoryInputSchema.safeParse({ name: 'ru@ads' }).success).toBe(false);
    expect(GeoCategoryInputSchema.safeParse({ name: 'ru gov' }).success).toBe(false);
  });

  it('rejects an invalid manual IP (validated at the edge, not silently dropped)', () => {
    expect(
      GeoCategoryInputSchema.safeParse({ name: 'x', manualIps: ['10.0.0.0/33'] }).success,
    ).toBe(false);
  });
});
