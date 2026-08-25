import { describe, expect, it } from 'vitest';
import { buildClashYaml } from './clash.js';
import { buildSingboxJson } from './singbox.js';
import { buildXrayJson } from './xrayjson.js';
import { buildSurgeConf } from './surge.js';
import { buildQuantumultXConf } from './quantumultx.js';
import { buildLoonConf } from './loon.js';
import { encodePlainList } from '../subscription.formats.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';

/**
 * Where the two wg flavours land in the formats that are NOT wg-quick.
 *
 * Same trade the transport matrix is about: "an empty section in a client is a
 * bad outcome; a server entry that fails every connect and says nothing is
 * worse". Neither flavour has anything a proxy list can carry - no URI scheme,
 * and a tunnel these formats' clients dial as a proxy hop does not exist - so
 * the only honest rendering is no entry at all. This pins that, because the
 * failure it guards against is silent by construction: a `wireguard` outbound
 * emitted into sing-box or Clash Meta would parse, show up as a server, and
 * never connect.
 *
 * The wg endpoints are reachable through `?format=wgconf`, which is what the
 * landing page links and what every WireGuard client imports.
 */
const awg: SubscriptionEndpoint = {
  protocol: 'amneziawg',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 51820,
  privateKey: 'cliPriv64',
  allowedIp: '10.66.66.42/32',
  serverPublicKey: 'srvPub64',
  jc: 4,
  jmin: 64,
  jmax: 128,
  s1: 32,
  s2: 56,
  s3: 0,
  s4: 0,
  h1: 100,
  h2: 200,
  h3: 300,
  h4: 400,
  uri: '',
};

const wg: SubscriptionEndpoint = {
  protocol: 'wireguard',
  nodeName: 'eu-2',
  host: 'n2.example.com',
  port: 51821,
  privateKey: 'cliPriv64',
  allowedIp: '10.77.77.42/32',
  serverPublicKey: 'wgSrvPub64',
  uri: '',
};

const ss: SubscriptionEndpoint = {
  protocol: 'shadowsocks',
  nodeName: 'eu-3',
  host: 'n3.example.com',
  port: 8388,
  method: '2022-blake3-aes-128-gcm',
  password: 'ss-pass',
  uri: 'ss://encoded#eu-3',
};

/**
 * Each format's control: an endpoint IT carries, so "no wg entry" is read as
 * omission rather than as the format bailing out on input it dislikes. They
 * differ because the formats differ - Surge has no VLESS/REALITY, and the
 * xray-JSON writer emits only xray and hysteria - and picking one fixture for
 * all six would silently turn the control into a second no-op assertion.
 */
const xrayEp: SubscriptionEndpoint = {
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
  uri: 'vless://uuid-1@n3.example.com:443#eu-3',
};

describe('wg endpoints in the proxy formats', () => {
  it.each([
    ['clash', (e: SubscriptionEndpoint[]) => buildClashYaml(e), xrayEp],
    ['singbox', (e: SubscriptionEndpoint[]) => buildSingboxJson(e), xrayEp],
    ['xrayjson', (e: SubscriptionEndpoint[]) => buildXrayJson(e), xrayEp],
    ['surge', (e: SubscriptionEndpoint[]) => buildSurgeConf(e), ss],
    ['quantumultx', (e: SubscriptionEndpoint[]) => buildQuantumultXConf(e), xrayEp],
    ['loon', (e: SubscriptionEndpoint[]) => buildLoonConf(e), xrayEp],
  ])('%s names neither wg node', (_name, build, control) => {
    const out = build([awg, wg, control]);
    expect(out).not.toContain('eu-1');
    expect(out).not.toContain('eu-2');
    expect(out).not.toContain('10.77.77.42');
    expect(out).not.toContain('wgSrvPub64');
    // ...while the endpoint that CAN be carried still is.
    expect(out).toContain('eu-3');
  });

  it('the plain base64 list carries neither', () => {
    const decoded = Buffer.from(
      encodePlainList([awg.uri, wg.uri, ss.uri]),
      'base64',
    ).toString('utf8');
    expect(decoded.split('\n').filter(Boolean)).toEqual(['ss://encoded#eu-3']);
  });
});
