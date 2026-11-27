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
import { effectiveDnsRules, mihomoNameserverPolicy, mihomoPolicyName, mihomoPolicyServer, singboxDnsRules, xrayDnsPinRules, xrayDnsRules } from './subscription.device-rules.js';
import { readFrame } from './subscription.frames.js';

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
        // The geoip rule needs IPOnDemand (f12-17, 17.6): an own preset with an
        // address rule gets it too, so the routing block is the same.
        expect(routingOf(own)).toEqual(routingOf(builtin));
        expect((routingOf(own) as { domainStrategy: string }).domainStrategy).toBe('IPOnDemand');
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

      // sing-box: the same file but for the split DNS, which an own preset does not get.
      const sbOwn = JSON.parse(buildSingboxJson(eps, { ownPresetRules: rules })) as Record<string, unknown>;
      const sbBuiltin = JSON.parse(buildSingboxJson(eps, { routingPreset: id })) as Record<string, unknown>;
      expect(sbBuiltin.dns).toBeDefined();
      expect(sbOwn.dns).toBeUndefined();
      expect((sbOwn.route as Record<string, unknown>).default_domain_resolver).toBeUndefined();
      delete sbBuiltin.dns;
      delete (sbBuiltin.route as Record<string, unknown>).default_domain_resolver;
      expect(sbOwn).toEqual(sbBuiltin);
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

describe.skipIf(!XRAY_BIN)('xray -test accepts the documents with DNS rules of every kind (19.4)', () => {
  const assets = process.env.XRAY_LOCATION_ASSET ?? dirname(XRAY_BIN);
  const haveGeo = existsSync(join(assets, 'geosite.dat')) && existsSync(join(assets, 'geoip.dat'));
  const dnsRules = [
    { match: ['corp.example', 'full:www.corp2.example'], server: '10.0.0.1', note: '' },
    { match: ['domain:a.example'], server: 'tcp://10.0.0.2:5353', note: '' },
    { match: ['b.example'], server: 'https://dns.corp.example/dns-query', note: '' },
    { match: ['c.example'], server: 'https://10.0.0.4:8443/q', note: '' },
    { match: ['d.example'], server: 'tcp://[2001:db8::53]', note: '' },
    { match: ['geosite:category-ads-all'], server: 'tcp://10.0.0.5', note: '' },
  ];
  it.skipIf(!haveGeo)('flat, balancer, array and xkeen, over a built-in and an own preset', () => {
    const opts = [{ routingPreset: 'ru-split' as const }, { ownPresetRules: EVERY_KIND }, { routingPreset: 'proxy-all' as const }];
    for (const o of opts) {
      for (const config of [
        buildXrayJson(LOADABLE, { ...o, dnsRules }),
        buildXrayJson(LOADABLE, { ...o, dnsRules, bundle: 'balancer' }),
        buildXrayJson(LOADABLE, { ...o, dnsRules, forRouter: true }),
        ...(JSON.parse(buildXrayJsonArray(LOADABLE, { ...o, dnsRules })) as unknown[]).map((c) => JSON.stringify(c)),
      ]) {
        expect(run(XRAY_BIN, (f) => ['-test', '-c', f], config, { XRAY_LOCATION_ASSET: assets })).toBe('');
      }
    }
  });
});

describe.skipIf(!XRAY_BIN)('xray -test accepts the split presets with the lists written in (f12-21)', () => {
  // No geo files are given: a document that names no category must load without them.
  const empty = mkdtempSync(join(tmpdir(), 'iceslab-nogeo-'));
  const INLINE = {
    'ru-split': {
      domains: { 'category-ru': ['domain:yandex.ru', 'full:www.example.ru', 'keyword:ruword', 'regexp:^a\\.ru$'], 'category-gov-ru': ['domain:gosuslugi.ru'] },
      cidrs: { ru: ['5.3.0.0/16', '77.88.0.0/16'] },
    },
  };
  it.each(['ru-split'] as const)('%s: flat, balancer and array', (routingPreset) => {
    const opts = { routingPreset, presetGeoInline: INLINE[routingPreset] };
    for (const config of [
      buildXrayJson(LOADABLE, opts),
      buildXrayJson(LOADABLE, { ...opts, bundle: 'balancer' }),
      ...(JSON.parse(buildXrayJsonArray(LOADABLE, opts)) as unknown[]).map((c) => JSON.stringify(c)),
    ]) {
      expect(config).not.toMatch(/geosite:|geoip:/);
      expect(run(XRAY_BIN, (f) => ['-test', '-c', f], config, { XRAY_LOCATION_ASSET: empty })).toBe('');
    }
  });
});

describe.skipIf(!SINGBOX_BIN)('sing-box check accepts the split DNS of the built-in presets (f12-20)', () => {
  it.each(['ru-split', 'cn-split'] as const)('%s, selector and url-test', (routingPreset) => {
    for (const bundle of ['selector', 'url-test'] as const) {
      const config = buildSingboxJson(LOADABLE, { routingPreset, bundle });
      expect(JSON.parse(config).dns, 'the block is there to be checked').toBeDefined();
      expect(run(SINGBOX_BIN, (f) => ['check', '-c', f], config)).toBe('');
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

describe('effectiveDnsRules (stage 19.2)', () => {
  const r = (server: string, ...match: string[]) => ({ match, server, note: '' });
  const own = { kind: 'custom' as const, dnsRules: [r('10.0.0.1', 'domain:corp.example')] };
  const panel = [r('tcp://10.0.0.9', 'domain:corp.example'), r('tcp://10.0.0.8', 'geosite:category-ads-all')];

  it('no sources, no rules', () => {
    expect(effectiveDnsRules({ kind: 'builtin' }, [])).toEqual([]);
    expect(effectiveDnsRules({ kind: 'custom', dnsRules: [] }, [])).toEqual([]);
  });

  it('only the preset: its rules', () => {
    expect(effectiveDnsRules(own, [])).toEqual(own.dnsRules);
  });

  it('only the panel-wide ones: a built-in preset gets them, an own preset without rules too', () => {
    expect(effectiveDnsRules({ kind: 'builtin' }, panel)).toEqual(panel);
    expect(effectiveDnsRules({ kind: 'custom', dnsRules: [] }, panel)).toEqual(panel);
  });

  it('both: the preset first, so its rule for the same name wins', () => {
    const out = effectiveDnsRules(own, panel);
    expect(out).toEqual([...own.dnsRules, ...panel]);
    expect(out[0]!.server).toBe('10.0.0.1');
  });
});

describe('xrayDnsRules (stage 19.4)', () => {
  const r = (server: string, ...match: string[]) => ({ match, server, note: '' });

  it('every kind xray runs: an IP, tcp://, https://; the names as the routing rules spell them', () => {
    const out = xrayDnsRules([
      r('10.0.0.1', 'corp.example'),
      r('tcp://10.0.0.2', 'domain:a.example', 'full:www.b.example'),
      r('tcp://10.0.0.3:5353', 'geosite:category-ads-all'),
      r('https://dns.corp.example/dns-query', 'c.example'),
      r('https://10.0.0.4:8443/q', 'd.example'),
      r('tcp://[2001:db8::53]', 'e.example'),
      r('2001:db8::54', 'f.example'),
    ]);
    expect(out.skipped).toEqual([]);
    expect(out.servers).toEqual([
      { address: '10.0.0.1', domains: ['domain:corp.example'], skipFallback: true },
      { address: 'tcp://10.0.0.2', domains: ['domain:a.example', 'full:www.b.example'], skipFallback: true },
      { address: 'tcp://10.0.0.3:5353', domains: ['geosite:category-ads-all'], skipFallback: true },
      { address: 'https://dns.corp.example/dns-query', domains: ['domain:c.example'], skipFallback: true },
      { address: 'https://10.0.0.4:8443/q', domains: ['domain:d.example'], skipFallback: true },
      { address: 'tcp://[2001:db8::53]', domains: ['domain:e.example'], skipFallback: true },
      { address: '2001:db8::54', domains: ['domain:f.example'], skipFallback: true },
    ]);
    expect(out.pins).toEqual({
      ips: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '2001:db8::53', '2001:db8::54'],
      hosts: ['dns.corp.example'],
    });
  });

  it('DoT is skipped and returned, with its rule and no pin', () => {
    const dot = r('tls://10.0.0.9', 'x.example');
    const out = xrayDnsRules([dot, r('tcp://10.0.0.2', 'y.example')]);
    expect(out.skipped).toEqual([dot]);
    expect(out.servers).toHaveLength(1);
    expect(out.pins.ips).toEqual(['10.0.0.2']);
  });

  it('nothing but DoT: no servers', () => {
    expect(xrayDnsRules([r('tls://dot.example', 'x.example')]).servers).toEqual([]);
    expect(xrayDnsRules([])).toEqual({ servers: [], pins: { ips: [], hosts: [] }, skipped: [] });
  });

  it('one address for two rules is pinned once', () => {
    expect(xrayDnsRules([r('tcp://10.0.0.2', 'a.example'), r('tcp://10.0.0.2:5353', 'b.example')]).pins.ips).toEqual(['10.0.0.2']);
  });

  it('the pin rules: addresses by ip, a name by full:, to the target', () => {
    expect(xrayDnsPinRules({ ips: ['10.0.0.2'], hosts: ['dns.corp.example'] }, { outboundTag: 'p' })).toEqual([
      { type: 'field', ip: ['10.0.0.2'], outboundTag: 'p' },
      { type: 'field', domain: ['full:dns.corp.example'], outboundTag: 'p' },
    ]);
    expect(xrayDnsPinRules({ ips: ['10.0.0.2'], hosts: [] }, { balancerTag: 'b' })).toEqual([{ type: 'field', ip: ['10.0.0.2'], balancerTag: 'b' }]);
    expect(xrayDnsPinRules({ ips: [], hosts: [] }, { outboundTag: 'p' })).toEqual([]);
  });
});

describe('singboxDnsRules (milestone 19.6)', () => {
  const r = (server: string, ...match: string[]) => ({ match, server, note: '' });

  it('a server of each kind, its names by kind', () => {
    const out = singboxDnsRules(
      [r('10.0.0.1', 'geosite:category-ru', 'a.example'), r('tcp://10.0.0.2:5300', 'full:b.example'), r('tls://dns.example', 'domain:c.example'), r('https://dns.example/q', 'd.example')],
      'Auto',
    );
    expect(out.servers.map((s) => [s.type, s.tag])).toEqual([
      ['udp', 'dns-udp-10.0.0.1'],
      ['tcp', 'dns-tcp-10.0.0.2:5300'],
      ['tls', 'dns-tls-dns.example'],
      ['https', 'dns-https-dns.example/q'],
    ]);
    expect(out.servers.every((s) => s.detour === 'Auto')).toBe(true);
    expect(out.rules).toEqual([
      { rule_set: ['geosite-category-ru'], server: 'dns-udp-10.0.0.1' },
      { domain_suffix: ['a.example'], server: 'dns-udp-10.0.0.1' },
      { domain: ['b.example'], server: 'dns-tcp-10.0.0.2:5300' },
      { domain_suffix: ['c.example'], server: 'dns-tls-dns.example' },
      { domain_suffix: ['d.example'], server: 'dns-https-dns.example/q' },
    ]);
    expect(out.ruleSets.map((s) => s.tag)).toEqual(['geosite-category-ru']);
  });

  it('one server for two rules, one rule-set for two names of it', () => {
    const out = singboxDnsRules([r('tcp://10.0.0.1', 'geosite:google'), r('tcp://10.0.0.1', 'geosite:google', 'x.example')], 'Auto');
    expect(out.servers).toHaveLength(1);
    expect(out.ruleSets).toHaveLength(1);
    expect(out.rules).toHaveLength(3);
  });

  it('no proxy, nothing; a server that does not parse, skipped', () => {
    expect(singboxDnsRules([r('10.0.0.1', 'a.example')], null)).toEqual({ servers: [], rules: [], ruleSets: [] });
    expect(singboxDnsRules([r('udp://10.0.0.1', 'a.example')], 'Auto').rules).toEqual([]);
  });
});

describe.skipIf(!XRAY_BIN)('xray -test accepts a template\'s own dns with the rules merged in (19.8)', () => {
  const assets = process.env.XRAY_LOCATION_ASSET ?? dirname(XRAY_BIN);
  const dnsRules = [
    { match: ['corp.example', 'full:www.corp2.example'], server: '10.0.0.1', note: '' },
    { match: ['domain:a.example'], server: 'tcp://10.0.0.2:5353', note: '' },
    { match: ['b.example'], server: 'https://dns.corp.example/dns-query', note: '' },
  ];
  it('flat, xkeen and array, over a built-in and an own preset, servers as strings, objects and absent', () => {
    const own = [{ queryStrategy: 'UseIPv4', servers: ['8.8.8.8', { address: '9.9.9.9', domains: ['domain:own.example'] }] }, { hosts: { 'h.example': '192.0.2.1' } }, {}];
    for (const dns of own) {
      const body = JSON.stringify({ iceslab: { routing: 'preset', dns: 'merge' }, dns, outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'block', protocol: 'blackhole' }], routing: { rules: [] } });
      for (const o of [{ routingPreset: 'proxy-all' as const }, { ownPresetRules: [{ match: ['example.io'], action: 'direct' as const, note: '' }] }]) {
        const single = readFrame('xray-json', body);
        for (const config of [
          buildXrayJson(LOADABLE, { ...o, frame: single, dnsRules }),
          buildXrayJson(LOADABLE, { ...o, frame: single, dnsRules, forRouter: true }),
          ...(JSON.parse(buildXrayJsonArray(LOADABLE, { ...o, frame: readFrame('xray-json-array', body), dnsRules })) as unknown[]).map((c) => JSON.stringify(c)),
        ]) {
          expect(JSON.parse(config).dns.servers.length).toBeGreaterThanOrEqual(3);
          expect(run(XRAY_BIN, (f) => ['-test', '-c', f], config, { XRAY_LOCATION_ASSET: assets })).toBe('');
        }
      }
    }
  });
});

describe.skipIf(!SINGBOX_BIN)('sing-box check accepts a template\'s own dns with the rules merged in (19.8)', () => {
  const r = (server: string, ...match: string[]) => ({ match, server, note: '' });
  const dnsRules = [
    r('10.0.0.1', 'a.example', 'geosite:category-ru'),
    r('tcp://10.0.0.2:5300', 'full:b.example'),
    r('tls://dns.example', 'domain:c.example'),
    r('https://dns.example:8443/q', 'd.example'),
  ];
  it.each([
    ['proxy-all', { routingPreset: 'proxy-all' as const }],
    ['ru-split', { routingPreset: 'ru-split' as const }],
    ['own', { ownPresetRules: EVERY_KIND }],
  ])('%s, a tag that clashes with a template server too', (_n, opts) => {
    const frame = readFrame('singbox', JSON.stringify({
      iceslab: { routing: 'preset', dns: 'merge' },
      dns: {
        servers: [{ type: 'udp', tag: 'own', server: '9.9.9.9' }, { type: 'udp', tag: 'dns-udp-10.0.0.1', server: '9.9.9.8' }],
        rules: [{ domain_suffix: ['own.example'], server: 'own' }],
        final: 'own',
      },
      outbounds: [{ type: 'selector', tag: 'Pick', outbounds: [] }, { type: 'direct', tag: 'direct' }],
      // A template's own dns is the operator's to complete: the proxy hosts need a resolver (1.12+).
      route: { final: 'Pick', default_domain_resolver: 'own' },
    }));
    const config = buildSingboxJson(LOADABLE, { ...opts, frame, dnsRules });
    const dns = JSON.parse(config).dns as { servers: { tag: string }[]; rules: unknown[] };
    expect(dns.servers.map((s) => s.tag)).toContain('dns-udp-10.0.0.1-2');
    expect(dns.rules.length).toBeGreaterThan(1);
    expect(run(SINGBOX_BIN, (f) => ['check', '-c', f], config)).toBe('');
  });
});

describe.skipIf(!SINGBOX_BIN)('sing-box check accepts DNS rules of every kind (milestone 19.6)', () => {
  const r = (server: string, ...match: string[]) => ({ match, server, note: '' });
  const dnsRules = [
    r('10.0.0.1', 'a.example', 'geosite:category-ru'),
    r('tcp://10.0.0.2:5300', 'full:b.example'),
    r('tls://dns.example', 'domain:c.example'),
    r('tls://[2001:db8::1]:8853', 'c6.example'),
    r('https://dns.example:8443/q', 'd.example'),
    r('https://1.1.1.1', 'e.example'),
  ];
  it.each([
    ['proxy-all', { routingPreset: 'proxy-all' as const }],
    ['ru-split', { routingPreset: 'ru-split' as const }],
    ['cn-split', { routingPreset: 'cn-split' as const }],
    ['own', { ownPresetRules: EVERY_KIND }],
  ])('%s, selector and url-test', (_n, opts) => {
    for (const bundle of ['selector', 'url-test'] as const) {
      const config = buildSingboxJson(LOADABLE, { ...opts, bundle, dnsRules });
      expect(JSON.parse(config).dns.rules.length).toBeGreaterThan(0);
      expect(run(SINGBOX_BIN, (f) => ['check', '-c', f], config)).toBe('');
    }
  });
});

describe('mihomo nameserver-policy (stage 19.5)', () => {
  const r = (server: string, ...match: string[]) => ({ match, server, note: '' });

  it('names: geosite stays, domain and a bare name are the name and its subdomains, full is exact', () => {
    expect(mihomoPolicyName('geosite:category-ads-all')).toBe('geosite:category-ads-all');
    expect(mihomoPolicyName('domain:corp.example')).toBe('+.corp.example');
    expect(mihomoPolicyName('corp.example')).toBe('+.corp.example');
    expect(mihomoPolicyName('full:host.corp.example')).toBe('host.corp.example');
  });

  it('names a policy key cannot carry are null', () => {
    for (const m of ['keyword:ads', 'regexp:^a', 'geosite:', 'full:', 'domain:', '']) expect(mihomoPolicyName(m), m).toBeNull();
  });

  it('servers: IP bare, tcp, tls, https; a default port is left out, another stays', () => {
    expect(mihomoPolicyServer('10.0.0.1', null)).toBe('10.0.0.1');
    expect(mihomoPolicyServer('tcp://10.0.0.1', null)).toBe('tcp://10.0.0.1');
    expect(mihomoPolicyServer('tcp://10.0.0.1:5353', null)).toBe('tcp://10.0.0.1:5353');
    expect(mihomoPolicyServer('tls://dns.example:853', null)).toBe('tls://dns.example');
    expect(mihomoPolicyServer('tls://dns.example:8853', null)).toBe('tls://dns.example:8853');
    expect(mihomoPolicyServer('https://dns.example', null)).toBe('https://dns.example/dns-query');
    expect(mihomoPolicyServer('https://10.0.0.1:8443/q', null)).toBe('https://10.0.0.1:8443/q');
  });

  it('an IPv6 server is bracketed', () => {
    expect(mihomoPolicyServer('2001:db8::1', 'Auto')).toBe('[2001:db8::1]#Auto');
    expect(mihomoPolicyServer('tcp://[2001:db8::1]:5353', 'Auto')).toBe('tcp://[2001:db8::1]:5353#Auto');
  });

  it('a group of ASCII letters, digits, - and _ is the suffix; a space or an emoji or a non-ASCII name leaves it off', () => {
    expect(mihomoPolicyServer('10.0.0.1', 'Auto')).toBe('10.0.0.1#Auto');
    expect(mihomoPolicyServer('10.0.0.1', 'g_1-b')).toBe('10.0.0.1#g_1-b');
    for (const g of ['my group', '🚀 Proxy', 'Прокси', 'a#b', '']) expect(mihomoPolicyServer('10.0.0.1', g), g).toBe('10.0.0.1');
  });

  it('a string that is no server is null', () => {
    expect(mihomoPolicyServer('udp://10.0.0.1', 'Auto')).toBeNull();
    expect(mihomoPolicyServer('dns.example', 'Auto')).toBeNull();
  });

  it('entries in rule order, a name met again keeps the first server, no group no entries', () => {
    const rules = [r('tcp://10.0.0.1', 'domain:a.example', 'full:b.example'), r('10.0.0.2', 'a.example', 'geosite:x')];
    expect(mihomoNameserverPolicy(rules, 'Auto')).toEqual([
      ['+.a.example', 'tcp://10.0.0.1#Auto'],
      ['b.example', 'tcp://10.0.0.1#Auto'],
      ['geosite:x', '10.0.0.2#Auto'],
    ]);
    expect(mihomoNameserverPolicy(rules, null)).toEqual([]);
    expect(mihomoNameserverPolicy([], 'Auto')).toEqual([]);
  });
});
