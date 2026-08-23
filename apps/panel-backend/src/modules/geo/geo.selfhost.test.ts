import { describe, expect, it } from 'vitest';
import { buildClashYaml } from '../subscription/formats/clash.js';
import { buildSingboxJson } from '../subscription/formats/singbox.js';
import { geoArtifactToken, geoArtifactBaseUrl } from './geo.url.js';
import { config } from '../../config.js';

describe('geo artifact URL', () => {
  it('derives a stable 32-hex capability token', () => {
    const t = geoArtifactToken();
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(geoArtifactToken()).toBe(t); // deterministic
  });
  it('builds the public base URL under PUBLIC_URL/geo/<token>', () => {
    const base = geoArtifactBaseUrl();
    expect(base.startsWith(config.PUBLIC_URL.replace(/\/+$/, ''))).toBe(true);
    expect(base).toMatch(/\/geo\/[0-9a-f]{32}$/);
  });
});

describe('clash formatter geo self-hosting (G6)', () => {
  it('points geox-url at the self-hosted mirror when geoBaseUrl is set', () => {
    const out = buildClashYaml([], {
      routingPreset: 'ru-split',
      geoBaseUrl: 'https://p.example/geo/tok',
    });
    expect(out).toContain('geodata-mode: true');
    expect(out).toContain('geosite: "https://p.example/geo/tok/geosite.dat"');
    expect(out).toContain('geoip: "https://p.example/geo/tok/geoip.dat"');
    expect(out).not.toContain('jsdelivr');
    expect(out).not.toContain('mmdb');
  });

  it('keeps the external jsdelivr mirror when geoBaseUrl is unset (byte-identical)', () => {
    const out = buildClashYaml([], { routingPreset: 'ru-split' });
    expect(out).toContain('testingcf.jsdelivr.net');
    expect(out).not.toContain('geodata-mode');
  });

  it('emits no geo block for proxy-all regardless of geoBaseUrl', () => {
    const out = buildClashYaml([], { routingPreset: 'proxy-all', geoBaseUrl: 'https://p.example/geo/tok' });
    expect(out).not.toContain('geox-url');
  });
});

describe('singbox formatter geo self-hosting (G6)', () => {
  it('points rule_set urls at the self-hosted .srs when geoBaseUrl is set', () => {
    const out = buildSingboxJson([], {
      routingPreset: 'ru-split',
      geoBaseUrl: 'https://p.example/geo/tok',
    });
    expect(out).toContain('https://p.example/geo/tok/geosite-category-ru.srs');
    expect(out).toContain('https://p.example/geo/tok/geoip-ru.srs');
    expect(out).not.toContain('githubusercontent');
  });

  it('keeps the SagerNet .srs urls when geoBaseUrl is unset (byte-identical)', () => {
    const out = buildSingboxJson([], { routingPreset: 'ru-split' });
    expect(out).toContain('raw.githubusercontent.com/SagerNet');
  });

  it('only rewrites rule-sets the build produced (a 404 .srs bricks sing-box)', () => {
    const out = buildSingboxJson([], {
      routingPreset: 'ru-split',
      geoBaseUrl: 'https://p.example/geo/tok',
      geoArtifacts: new Set(['geosite-category-ads-all.srs']),
    });
    expect(out).toContain('https://p.example/geo/tok/geosite-category-ads-all.srs');
    // geoip-ru.srs was not built -> its external default survives
    expect(out).toContain(
      'raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs',
    );
  });
});
