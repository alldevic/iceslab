import { describe, expect, it } from 'vitest';
import { buildHysteriaUri } from '../../core-adapters/hysteria/index.js';
import { buildSingboxJson } from './formats/singbox.js';
import { buildClashYaml } from './formats/clash.js';
import { buildSurgeConf } from './formats/surge.js';
import type { SubscriptionEndpoint } from './subscription.formats.js';

/**
 * Which certificate a hysteria client will meet is decided by the ENGINE, not
 * by the protocol. The native hysteria core holds an ACME certificate for the
 * node's own name. The sing-box engine holds the self-signed one
 * bootstrap-singbox.sh writes — CN=www.bing.com, no IP SANs — the very same
 * file TUIC and AnyTLS use, and those two have emitted an insecure flag by
 * default since they existed.
 *
 * Hysteria's link did not, in any of the four places that emit it, and the
 * failure is total. Measured 2026-08-30 against a sing-box hysteria2 inbound
 * holding that certificate, with a client built from exactly the link the panel
 * emits:
 *
 *   sni=<node host>, verify on   -> cannot validate certificate for 127.0.0.1
 *                                   because it doesn't contain any IP SANs
 *   sni=www.bing.com, verify on  -> certificate signed by unknown authority
 *   verify off                   -> HTTP 200 through the tunnel
 *
 * The second line is why the fix is not "send the right SNI": the certificate
 * is untrusted whatever name is asked for. So no client could connect to a
 * hysteria profile on this engine, in any format.
 *
 * Both directions are asserted throughout. "Emits insecure" is worth nothing
 * unless the native core's link is also checked to still verify — that
 * certificate is real, and turning verification off there would throw away the
 * only thing checking it.
 */

const base = {
  nodeName: 'n1',
  host: 'node.example',
  port: 8443,
  nodeId: 'node-1',
} as const;

const hysteriaEndpoint = (allowInsecure: boolean): SubscriptionEndpoint =>
  ({
    protocol: 'hysteria',
    ...base,
    password: 'pw',
    upMbps: 100,
    downMbps: 200,
    allowInsecure,
    uri: buildHysteriaUri({
      password: 'pw',
      host: base.host,
      port: base.port,
      name: base.nodeName,
      upMbps: 100,
      downMbps: 200,
      allowInsecure,
    }),
  }) as unknown as SubscriptionEndpoint;

describe('the hysteria share link against the certificate the engine serves', () => {
  it('admits the self-signed certificate when sing-box is the engine', () => {
    const uri = buildHysteriaUri({
      password: 'pw',
      host: base.host,
      port: base.port,
      name: base.nodeName,
      allowInsecure: true,
    });
    expect(new URL(uri).searchParams.get('insecure')).toBe('1');
  });

  it('keeps verifying the ACME certificate of the native core', () => {
    const uri = buildHysteriaUri({
      password: 'pw',
      host: base.host,
      port: base.port,
      name: base.nodeName,
    });
    expect(
      new URL(uri).searchParams.get('insecure'),
      'the native core holds a real certificate for the name the client dials; not verifying it discards the only check there is',
    ).toBeNull();
  });
});

// One inbound, four ways to describe it. A client importing the sing-box config
// and a client importing the URI must meet the same certificate policy, or the
// profile works in some apps and not others - which reads as a client bug.
describe('every format that describes a hysteria endpoint', () => {
  const cases: Array<{ name: string; run: (e: SubscriptionEndpoint) => string; marker: RegExp }> = [
    { name: 'sing-box', run: (e) => buildSingboxJson([e]), marker: /"insecure":\s*true/ },
    { name: 'clash', run: (e) => buildClashYaml([e]), marker: /skip-cert-verify:\s*true/ },
    { name: 'surge', run: (e) => buildSurgeConf([e]), marker: /skip-cert-verify=true/ },
    { name: 'uri', run: (e) => (e as { uri: string }).uri, marker: /insecure=1/ },
  ];

  for (const { name, run, marker } of cases) {
    it(`${name} admits it on the sing-box engine`, () => {
      expect(run(hysteriaEndpoint(true))).toMatch(marker);
    });

    it(`${name} does not admit it on the native core`, () => {
      expect(run(hysteriaEndpoint(false))).not.toMatch(marker);
    });
  }
});
