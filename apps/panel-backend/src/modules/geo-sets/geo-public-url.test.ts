import { describe, expect, it } from 'vitest';
import { geoArtifactBaseUrl, geoArtifactToken, isGeoArtifactToken } from './geo-public-url.js';

const cfg = (over: Record<string, unknown> = {}) => ({
  JWT_SECRET: 'a'.repeat(32),
  GEO_ARTIFACT_TOKEN: undefined,
  PUBLIC_URL: 'https://panel.example.com/',
  SUBSCRIPTION_PUBLIC_URL: undefined,
  ...over,
});

describe('the geo token', () => {
  it('is derived from JWT_SECRET: stable, 32 hex, different for another secret', () => {
    const t = geoArtifactToken(cfg());
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(geoArtifactToken(cfg())).toBe(t);
    expect(geoArtifactToken(cfg({ JWT_SECRET: 'b'.repeat(32) }))).not.toBe(t);
    expect(t).not.toContain('aaaa');
  });

  it('a set GEO_ARTIFACT_TOKEN wins over the derived one', () => {
    expect(geoArtifactToken(cfg({ GEO_ARTIFACT_TOKEN: 'explicit-token-0123456789' }))).toBe('explicit-token-0123456789');
  });

  it('is compared whole: the right one passes, a prefix, an extension and a blank do not', () => {
    const c = cfg();
    const t = geoArtifactToken(c);
    expect(isGeoArtifactToken(t, c)).toBe(true);
    expect(isGeoArtifactToken(t.slice(0, 31), c)).toBe(false);
    expect(isGeoArtifactToken(`${t}0`, c)).toBe(false);
    expect(isGeoArtifactToken('', c)).toBe(false);
  });
});

describe('the base address', () => {
  it('is on the subscription domain when it is set, else on PUBLIC_URL, no double slash', () => {
    const t = geoArtifactToken(cfg());
    expect(geoArtifactBaseUrl(cfg())).toBe(`https://panel.example.com/geo/${t}`);
    expect(geoArtifactBaseUrl(cfg({ SUBSCRIPTION_PUBLIC_URL: 'https://sub.example.org/' }))).toBe(`https://sub.example.org/geo/${t}`);
  });
});
