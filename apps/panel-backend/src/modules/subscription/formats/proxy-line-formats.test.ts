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

describe('buildLoonConf (best-effort, incl REALITY)', () => {
  it('emits a VLESS REALITY line', () => {
    const out = buildLoonConf([vlessReality]);
    expect(out).toContain('eu-3 = VLESS,n3.example.com,443,"uuid-1"');
    expect(out).toContain('over-tls:true');
    expect(out).toContain('tls-name:www.cloudflare.com');
    expect(out).toContain('flow:xtls-rprx-vision');
    expect(out).toContain('public-key:PUBKEY');
    expect(out).toContain('short-id:SHORT');
  });
  it('emits a Shadowsocks line', () => {
    expect(buildLoonConf([ss])).toContain(
      'eu-1 = Shadowsocks,n.example.com,8388,2022-blake3-aes-128-gcm,"ss-pass"',
    );
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

