import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTING_PRESET_IDS } from '@iceslab/shared';
import { BUILTIN_PRESET_RULES, type DeviceRouteRule } from '../routing-presets/routing-presets.builtins.js';
import { buildXrayJson, buildXrayJsonArray } from './formats/xrayjson.js';
import { buildClashYaml } from './formats/clash.js';
import { buildSingboxJson } from './formats/singbox.js';

/**
 * A-229 part 4: device routing presets rendered from one structure.
 *
 *   1. The built-ins, now drawn from BUILTIN_PRESET_RULES, are byte for byte
 *      what the format constants drew before (golden taken before the move).
 *   2. An own preset with a built-in's rules routes the same in all three
 *      formats; the DNS part differs on purpose (an own preset names no
 *      country, so no country resolver), and is checked as such.
 *   3. A config carrying every kind of matcher passes xray -test and
 *      sing-box check, with the binaries.
 */

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(here, 'formats', '__testdata__', 'builtin-presets.golden.json');

const ep = {
  protocol: 'xray', nodeName: 'n1', host: 'n.example.com', port: 443, uuid: '11111111-1111-4111-8111-111111111111',
  publicKey: 'PUB', shortId: 'S', sni: 'www.example.com', flow: '', fingerprint: 'chrome', network: 'raw',
  subprotocol: 'vless', securityLayer: 'default', uri: '',
};
const hy = { protocol: 'hysteria', nodeName: 'h1', host: 'h.example.com', port: 443, password: 'pw', uri: '' };
const SETS = [[ep, hy], [], [ep, { ...ep, nodeName: 'n2', uuid: '22222222-2222-4222-8222-222222222222' }]] as never[][];

/** The same 42 outputs the golden was taken from, before the constants went. */
function builtinOutputs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const preset of ROUTING_PRESET_IDS) {
    for (const eps of SETS) {
      const k = `${preset}/${eps.length}`;
      out[`xray-flat/${k}`] = buildXrayJson(eps, { routingPreset: preset });
      out[`xray-bal/${k}`] = buildXrayJson(eps, { routingPreset: preset, bundle: 'balancer' });
      out[`xray-arr/${k}`] = buildXrayJsonArray(eps, { routingPreset: preset });
      out[`xkeen/${k}`] = buildXrayJson(eps, { routingPreset: preset, forRouter: true });
      out[`clash/${k}`] = buildClashYaml(eps, { routingPreset: preset });
      out[`singbox/${k}`] = buildSingboxJson(eps, { routingPreset: preset });
      out[`singbox-ut/${k}`] = buildSingboxJson(eps, { routingPreset: preset, bundle: 'url-test' });
    }
  }
  return out;
}

describe('the built-in presets, drawn from BUILTIN_PRESET_RULES', () => {
  it('are byte for byte what the format constants drew (golden from before the move)', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    const now = builtinOutputs();
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden).sort());
    for (const [k, v] of Object.entries(golden)) expect(now[k], k).toBe(v);
  });
});

const routingOf = (json: string) => (JSON.parse(json) as { routing: unknown }).routing;
const rulesOf = (yaml: string) => yaml.slice(yaml.indexOf('\nrules:\n'));
const dnsOf = (yaml: string) => yaml.slice(0, yaml.indexOf('\nproxies:'));

describe('an own preset with a built-in\'s rules', () => {
  for (const id of ['ru-split', 'cn-split'] as const) {
    it(`${id}: the same routing in xray-json (flat, array, xkeen), Clash and sing-box`, () => {
      const rules = BUILTIN_PRESET_RULES[id];
      const eps = SETS[0]!;
      // xray-json: the routing block is the same; no split DNS for an own preset.
      for (const build of [
        (o: object) => buildXrayJson(eps, o),
        (o: object) => buildXrayJson(eps, { ...o, forRouter: true }),
        (o: object) => buildXrayJson(SETS[2]!, { ...o, bundle: 'balancer' }),
      ]) {
        const builtin = build({ routingPreset: id });
        const own = build({ ownPresetRules: rules });
        expect(routingOf(own)).toEqual(routingOf(builtin));
        expect(JSON.parse(own).dns).toBeUndefined();
      }
      const arrBuiltin = JSON.parse(buildXrayJsonArray(eps, { routingPreset: id })) as { routing: unknown }[];
      const arrOwn = JSON.parse(buildXrayJsonArray(eps, { ownPresetRules: rules })) as { routing: unknown; dns?: unknown }[];
      expect(arrOwn.map((c) => c.routing)).toEqual(arrBuiltin.map((c) => c.routing));
      expect(arrOwn.every((c) => c.dns === undefined)).toBe(true);

      // Clash: the same rules and geo block; the proxy-all DNS, not the country's.
      const clashBuiltin = buildClashYaml(eps, { routingPreset: id });
      const clashOwn = buildClashYaml(eps, { ownPresetRules: rules });
      expect(rulesOf(clashOwn)).toBe(rulesOf(clashBuiltin));
      expect(clashOwn).toContain('geox-url:');
      expect(dnsOf(clashOwn)).not.toContain('nameserver-policy');
      expect(dnsOf(clashOwn)).toContain(dnsOf(buildClashYaml(eps, { routingPreset: 'proxy-all' })).trimStart());

      // sing-box carries no DNS for any preset: the whole file is the same.
      expect(buildSingboxJson(eps, { ownPresetRules: rules })).toBe(buildSingboxJson(eps, { routingPreset: id }));
    });
  }
});

/** Every kind of matcher a device rule may hold, and every action. */
const EVERY_KIND: DeviceRouteRule[] = [
  { match: ['geosite:category-ads-all', 'keyword:tracker'], action: 'block', note: '' },
  { match: ['domain:example.com', 'full:www.example.org', 'regexp:^.+\\.example\\.net$', 'example.io'], action: 'direct', note: '' },
  { match: ['geoip:private', '10.1.0.0/16', '2001:db8::/32', '192.0.2.1'], action: 'direct', note: '' },
  { match: ['port:25', 'port:6881-6889'], action: 'block', note: '' },
  { match: ['geosite:google', 'geoip:us'], action: 'proxy', note: '' },
];

describe('an own preset of every kind of matcher', () => {
  it('renders each kind in each format', () => {
    const eps = SETS[0]!;
    const xray = JSON.stringify(routingOf(buildXrayJson(eps, { ownPresetRules: EVERY_KIND })));
    for (const s of ['"port":"25,6881-6889"', '"domain":["domain:example.com","full:www.example.org"', '"ip":["geoip:private","10.1.0.0/16"']) {
      expect(xray).toContain(s);
    }
    const clash = buildClashYaml(eps, { ownPresetRules: EVERY_KIND });
    for (const s of [
      '  - DOMAIN-KEYWORD,tracker,REJECT',
      '  - DOMAIN-SUFFIX,example.com,DIRECT',
      '  - DOMAIN,www.example.org,DIRECT',
      '  - DOMAIN-REGEX,^.+\\.example\\.net$,DIRECT',
      '  - DOMAIN-SUFFIX,example.io,DIRECT',
      '  - IP-CIDR,10.1.0.0/16,DIRECT,no-resolve',
      '  - IP-CIDR6,2001:db8::/32,DIRECT,no-resolve',
      '  - IP-CIDR,192.0.2.1/32,DIRECT,no-resolve',
      '  - DST-PORT,6881-6889,REJECT',
      '  - GEOSITE,google,Auto',
      '  - GEOIP,US,Auto',
    ]) {
      expect(clash).toContain(s);
    }
    const sb = JSON.parse(buildSingboxJson(eps, { ownPresetRules: EVERY_KIND })) as {
      route: { rules: Record<string, unknown>[]; rule_set: { tag: string; url: string }[] };
    };
    expect(sb.route.rule_set.map((r) => r.tag)).toEqual(['geosite-category-ads-all', 'geosite-google', 'geoip-us']);
    expect(sb.route.rule_set.every((r) => r.url.startsWith('https://raw.githubusercontent.com/SagerNet/sing-geo'))).toBe(true);
    expect(sb.route.rules).toContainEqual({ port: [25], action: 'reject' });
    expect(sb.route.rules).toContainEqual({ port_range: ['6881:6889'], action: 'reject' });
    expect(sb.route.rules).toContainEqual({ ip_cidr: ['10.1.0.0/16', '2001:db8::/32', '192.0.2.1/32'], action: 'route', outbound: 'direct' });
    expect(sb.route.rules).toContainEqual({ rule_set: ['geosite-google', 'geoip-us'], action: 'route', outbound: 'Auto' });
  });

  it('leaves a proxy rule out when the config has no proxy (the catch-all is direct then)', () => {
    const xray = JSON.stringify(routingOf(buildXrayJson([], { ownPresetRules: EVERY_KIND })));
    expect(xray).not.toContain('geosite:google');
    expect(buildClashYaml([], { ownPresetRules: EVERY_KIND })).not.toContain('GEOSITE,google');
    expect(buildSingboxJson([], { ownPresetRules: EVERY_KIND })).not.toContain('geosite-google');
  });
});

describe('a bare hostname reads the same in the three formats', () => {
  // Each format's own reading of what it was handed, as its docs state it:
  //   xray: domain: = the domain or a subdomain, keyword: and a bare string =
  //         a substring (Xray-docs-next config/routing.md, RuleObject.domain);
  //   mihomo: DOMAIN-SUFFIX = the domain or a subdomain;
  //   sing-box: domain_suffix = the same.
  const suffix = (rule: string, host: string) => host === rule || host.endsWith(`.${rule}`);
  const xrayMatches = (entry: string, host: string) =>
    entry.startsWith('domain:')
      ? suffix(entry.slice(7), host)
      : entry.startsWith('full:')
        ? host === entry.slice(5)
        : host.includes(entry.replace(/^keyword:/, ''));

  const rules: DeviceRouteRule[] = [{ match: ['google.com'], action: 'direct', note: '' }];
  const eps = SETS[0]!;
  const xrayEntries = (JSON.parse(buildXrayJson(eps, { ownPresetRules: rules })) as {
    routing: { rules: { domain?: string[] }[] };
  }).routing.rules.flatMap((r) => r.domain ?? []);
  const clashSuffixes = [...buildClashYaml(eps, { ownPresetRules: rules }).matchAll(/ {2}- DOMAIN-SUFFIX,([^,]+),DIRECT/g)].map((m) => m[1]!);
  const sbSuffixes = (JSON.parse(buildSingboxJson(eps, { ownPresetRules: rules })) as {
    route: { rules: { domain_suffix?: string[] }[] };
  }).route.rules.flatMap((r) => r.domain_suffix ?? []);

  it('is written as the domain and its subdomains in each', () => {
    expect(xrayEntries).toEqual(['domain:google.com']);
    expect(clashSuffixes).toEqual(['google.com']);
    expect(sbSuffixes).toEqual(['google.com']);
  });

  for (const [host, hit] of [
    ['google.com', true],
    ['mail.google.com', true],
    ['notgoogle.com.example', false],
  ] as const) {
    it(`${host}: ${hit ? 'matched' : 'not matched'} by all three`, () => {
      expect(xrayEntries.some((e) => xrayMatches(e, host)), 'xray').toBe(hit);
      expect(clashSuffixes.some((s) => suffix(s, host)), 'clash').toBe(hit);
      expect(sbSuffixes.some((s) => suffix(s, host)), 'sing-box').toBe(hit);
    });
  }
});

// ------------------------------------------------------------ the binaries

const XRAY_BIN = process.env.XRAY_BIN ?? ['/usr/local/bin/xray', '/usr/bin/xray'].find((p) => existsSync(p)) ?? '';
const SINGBOX_BIN = process.env.SINGBOX_BIN ?? ['/usr/local/bin/sing-box', '/usr/bin/sing-box'].find((p) => existsSync(p)) ?? '';

/** Two endpoints the cores load: a real-shaped x25519 key and a hex short id
 *  (the golden's placeholders are refused before the routing is read). */
const KEY = 'aWNlc2xhYi1kcnlydW4tcmVhbGl0eS1maXh0dXJlLTA';
const LOADABLE = [
  { ...ep, publicKey: KEY, shortId: '0123abcd' },
  { ...ep, nodeName: 'n2', uuid: '22222222-2222-4222-8222-222222222222', publicKey: KEY, shortId: '0123abcd' },
] as never[];

function run(bin: string, args: (file: string) => string[], config: string, env: NodeJS.ProcessEnv = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'iceslab-preset-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, config);
  try {
    execFileSync(bin, args(file), { encoding: 'utf8', env: { ...process.env, ...env }, stdio: 'pipe' });
    return '';
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`;
  }
}

describe.skipIf(!XRAY_BIN)('xray -test accepts an own preset of every kind', () => {
  // geosite:/geoip: are looked up in the .dat files next to the binary (or in
  // XRAY_LOCATION_ASSET); a pinned binary without them cannot judge the rule.
  const assets = process.env.XRAY_LOCATION_ASSET ?? dirname(XRAY_BIN);
  const haveGeo = existsSync(join(assets, 'geosite.dat')) && existsSync(join(assets, 'geoip.dat'));
  it.skipIf(!haveGeo)('flat, balancer and array configs', () => {
    const eps = LOADABLE;
    for (const config of [
      buildXrayJson(eps, { ownPresetRules: EVERY_KIND }),
      buildXrayJson(eps, { ownPresetRules: EVERY_KIND, bundle: 'balancer' }),
      ...(JSON.parse(buildXrayJsonArray(eps, { ownPresetRules: EVERY_KIND })) as unknown[]).map((c) => JSON.stringify(c)),
    ]) {
      expect(run(XRAY_BIN, (f) => ['-test', '-c', f], config, { XRAY_LOCATION_ASSET: assets })).toBe('');
    }
  });
});

describe.skipIf(!SINGBOX_BIN)('sing-box check accepts an own preset of every kind', () => {
  it('selector and url-test', () => {
    for (const bundle of ['selector', 'url-test'] as const) {
      const config = buildSingboxJson(LOADABLE, { ownPresetRules: EVERY_KIND, bundle });
      expect(run(SINGBOX_BIN, (f) => ['check', '-c', f], config)).toBe('');
    }
  });
});
