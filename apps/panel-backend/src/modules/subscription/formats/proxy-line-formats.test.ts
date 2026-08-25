import { describe, expect, it } from 'vitest';
import { buildSurgeConf } from './surge.js';
import { buildQuantumultXConf } from './quantumultx.js';
import { buildLoonConf } from './loon.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';

const ss: SubscriptionEndpoint = {
  protocol: 'shadowsocks',
  nodeName: 'eu-1',
  host: 'n.example.com',
  port: 8388,
  method: '2022-blake3-aes-128-gcm',
  password: 'ss-pass',
  uri: '',
};
const hy: SubscriptionEndpoint = {
  protocol: 'hysteria',
  nodeName: 'eu-2',
  host: 'n2.example.com',
  port: 443,
  password: 'hy-pass',
  obfsPassword: 'salt',
  downMbps: 100,
  uri: '',
};
const vlessReality: SubscriptionEndpoint = {
  protocol: 'xray',
  nodeName: 'eu-3',
  host: 'n3.example.com',
  port: 443,
  uuid: 'uuid-1',
  publicKey: 'PUBKEY',
  shortId: 'SHORT',
  sni: 'www.cloudflare.com',
  flow: 'xtls-rprx-vision',
  fingerprint: 'chrome',
  network: 'raw',
  subprotocol: 'vless',
  securityLayer: 'default',
  uri: '',
};
const trojanTls: SubscriptionEndpoint = {
  ...vlessReality,
  nodeName: 'eu-4',
  subprotocol: 'trojan',
  securityLayer: 'tls',
};

describe('buildSurgeConf (ss/vmess/trojan/hy2, no vless/REALITY)', () => {
  it('emits ss + hysteria2 lines', () => {
    const out = buildSurgeConf([ss, hy]);
    expect(out).toContain('eu-1 = ss, n.example.com, 8388, encrypt-method=2022-blake3-aes-128-gcm, password=ss-pass');
    expect(out).toContain('eu-2 = hysteria2, n2.example.com, 443, password=hy-pass');
    expect(out).toContain('download-bandwidth=100');
    expect(out).toContain('salamander-password=salt');
  });
  it('skips REALITY xray (Surge cannot do reality/vless)', () => {
    expect(buildSurgeConf([vlessReality])).toBe('');
  });
  it('emits a trojan line over real TLS', () => {
    expect(buildSurgeConf([trojanTls])).toContain(
      'eu-4 = trojan, n3.example.com, 443, password=uuid-1, sni=www.cloudflare.com',
    );
  });
});

describe('buildQuantumultXConf (incl REALITY, verified syntax)', () => {
  it('emits a vless REALITY line with the verified reality params', () => {
    const out = buildQuantumultXConf([vlessReality]);
    expect(out).toContain('vless=n3.example.com:443');
    expect(out).toContain('password=uuid-1');
    expect(out).toContain('obfs=over-tls');
    expect(out).toContain('obfs-host=www.cloudflare.com');
    expect(out).toContain('reality-base64-pubkey=PUBKEY');
    expect(out).toContain('reality-hex-shortid=SHORT');
    expect(out).toContain('vless-flow=xtls-rprx-vision');
    expect(out).toContain('tag=eu-3');
  });
  it('emits a shadowsocks line', () => {
    expect(buildQuantumultXConf([ss])).toContain(
      'shadowsocks=n.example.com:8388, method=2022-blake3-aes-128-gcm, password=ss-pass',
    );
  });
  it('skips hysteria (QX unsupported)', () => {
    expect(buildQuantumultXConf([hy])).toBe('');
  });
});

/**
 * Loon's grammar, checked against three sources that agree: Loon's manual
 * (`LoonManual/docs/cn/node.md`), Loon's own examples (`LoonExampleConfig`) and
 * sub-store's Loon producer.
 *
 * These assertions are on WHOLE LINES rather than on fragments, and that is the
 * point of the rewrite. The version before this one checked six substrings, all
 * six in the `key:value` form that is not Loon's grammar anywhere - so it agreed
 * with the builder, exactly and only because both were wrong. A fragment check
 * can confirm a separator it supplied itself; a whole line cannot.
 */
describe('buildLoonConf, against the verified grammar', () => {
  it('writes a VLESS REALITY line the way all three sources spell it', () => {
    // `sni=` and not `tls-name=`: sub-store emits `tls-name` only on the
    // non-REALITY branch, and the old builder emitted both.
    expect(buildLoonConf([vlessReality]).trim()).toBe(
      'eu-3 = VLESS,n3.example.com,443,"uuid-1",transport=tcp,over-tls=true,' +
        'flow=xtls-rprx-vision,sni=www.cloudflare.com,public-key="PUBKEY",short-id=SHORT',
    );
  });

  it('gives a ws endpoint the path and host it needs to arrive anywhere', () => {
    // The old builder emitted neither, ever. A ws line without them dials `/`
    // at a server listening on `/dl` - an import that looks clean and connects
    // to nothing, which is what `loon:ws` meant by `partial` in the matrix.
    const out = buildLoonConf([
      { ...vlessReality, network: 'ws', path: '/dl', hostHeader: 'cdn.example.com' },
    ]).trim();
    expect(out).toContain('transport=ws,path=/dl,host=cdn.example.com');
    // Vision does not survive the move off raw, and must not be claimed here.
    expect(out).not.toContain('flow=');
  });

  it('declines grpc rather than naming a transport Loon cannot speak', () => {
    // Not in Loon's manual, not in either example config, and sub-store throws
    // `network grpc is unsupported` instead of degrading it.
    expect(buildLoonConf([{ ...vlessReality, network: 'grpc', serviceName: 'gsvc' }])).toBe('');
  });

  it('names a plain TLS endpoint with tls-name, and claims no REALITY keys', () => {
    const out = buildLoonConf([trojanTls]).trim();
    expect(out).toContain('tls-name=www.cloudflare.com');
    expect(out).not.toContain('public-key');
    expect(out).not.toContain('sni=');
  });

  it('emits a Shadowsocks line', () => {
    expect(buildLoonConf([ss])).toContain(
      'eu-1 = Shadowsocks,n.example.com,8388,2022-blake3-aes-128-gcm,"ss-pass"',
    );
  });

  it('writes every keyed parameter with =, on every line it produces', () => {
    // The blanket check. The defect was not any one key, it was the separator,
    // so this walks whatever the builder emits rather than a list of keys
    // someone remembered to update - a key added later in `:` form lands here
    // without anybody thinking to add a case for it.
    const out = buildLoonConf([
      vlessReality,
      trojanTls,
      { ...vlessReality, nodeName: 'ws-1', network: 'ws', path: '/dl' },
      { ...vlessReality, nodeName: 'plain', securityLayer: 'none' },
      ss,
    ]);
    expect(out).not.toBe('');
    for (const line of out.trim().split('\n')) {
      // Drop the `name = TYPE,host,port,...` head; what follows is key=value.
      const params = line.split(',').slice(1);
      const colonKeyed = params.filter((x) => /^[a-z-]+:/.test(x.trim()));
      expect(colonKeyed, `colon-keyed parameter in: ${line}`).toEqual([]);
    }
  });
});

// U5 - neither line grammar has a slot for the VLESS-Encryption client string,
// so an endpoint that needs one cannot be written down here at all. It is left
// out rather than written down wrong: an imported server that fails every
// connect and explains nothing is worse than one that never appeared.
describe('proxy-line formats and VLESS-Encryption (U5)', () => {
  const pq: SubscriptionEndpoint = {
    ...vlessReality,
    vlessEncryption: 'mlkem768x25519plus.native.0rtt.AAAA',
  };

  it('quantumult x drops the endpoint', () => {
    expect(buildQuantumultXConf([pq])).toBe('');
  });

  it('loon drops the endpoint', () => {
    expect(buildLoonConf([pq])).toBe('');
  });

  it('keeps the endpoint when only the verify key is unrepresentable', () => {
    const degraded: SubscriptionEndpoint = { ...vlessReality, realityMldsa65Verify: 'VK' };
    expect(buildQuantumultXConf([degraded])).toContain('vless=');
    expect(buildLoonConf([degraded])).toContain('VLESS');
  });
});

