import { describe, expect, it } from 'vitest';
import { buildHysteriaUri } from '../../core-adapters/hysteria/index.js';
import { buildSingboxJson } from './formats/singbox.js';
import { buildClashYaml } from './formats/clash.js';
import { buildSurgeConf } from './formats/surge.js';
import { buildLoonConf } from './formats/loon.js';
import type { SubscriptionEndpoint } from './subscription.formats.js';

/**
 * Which certificate a hysteria client meets is decided by the ENGINE, not by
 * the protocol. The native core holds a certificate for the node's own name.
 * The sing-box engine holds the self-signed one bootstrap-singbox.sh writes
 * (CN=www.bing.com, no IP SANs): no client verifies it by name, and a link
 * without a pin for it connects nowhere (measured 2026-08-30).
 *
 * The answer is the pin the node's agent reports (hysteria-tls-shape.ts), not a
 * flag that turns verification off: every format that spells a pin spells this
 * one, and with no pin (an agent that does not report yet) the endpoint goes
 * out as the base hands it out, with no "do not verify" flag in any format.
 * Both directions are asserted: a flag where there is a pin, or a pin that is
 * dropped, would each discard the one check there is.
 */

const base = { nodeName: 'n1', host: 'node.example', port: 8443, nodeId: 'node-1' } as const;

const pin = {
  certSha256: 'ab'.repeat(32),
  certPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
  serverName: 'www.bing.com',
};

const hysteriaEndpoint = (withPin: boolean): SubscriptionEndpoint =>
  ({
    protocol: 'hysteria',
    engine: 'singbox',
    ...base,
    password: 'pw',
    upMbps: 100,
    downMbps: 200,
    ...(withPin ? { tlsPin: pin } : {}),
    uri: buildHysteriaUri({
      password: 'pw',
      host: base.host,
      port: base.port,
      name: base.nodeName,
      upMbps: 100,
      downMbps: 200,
      pinSha256: withPin ? pin.certSha256 : undefined,
    }),
  }) as unknown as SubscriptionEndpoint;

describe('every format that describes a hysteria endpoint on sing-box', () => {
  const cases: Array<{ name: string; run: (e: SubscriptionEndpoint) => string; pinned: RegExp }> = [
    { name: 'sing-box', run: (e) => buildSingboxJson([e]), pinned: /"server_name":\s*"www\.bing\.com"[\s\S]*"certificate"/ },
    { name: 'clash', run: (e) => buildClashYaml([e]), pinned: new RegExp(`fingerprint: ${pin.certSha256}`) },
    {
      name: 'stash',
      run: (e) => buildClashYaml([e], { dialect: 'stash' }),
      pinned: new RegExp(`server-cert-fingerprint: ${pin.certSha256}`),
    },
    { name: 'surge', run: (e) => buildSurgeConf([e]), pinned: new RegExp(`server-cert-fingerprint-sha256=${pin.certSha256}`) },
    { name: 'loon', run: (e) => buildLoonConf([e]), pinned: new RegExp(`tls-cert-sha256=${pin.certSha256}`) },
    { name: 'uri', run: (e) => (e as { uri: string }).uri, pinned: new RegExp(`pinSHA256=${pin.certSha256}`) },
  ];
  // The flag that switches the check off, in each spelling, except where it
  // rides with a pin by construction (the hysteria link, see uri.ts).
  const unchecked = /"insecure":\s*true|skip-cert-verify[:=]\s*true|allowInsecure|insecure=1/;

  for (const { name, run, pinned } of cases) {
    it(`${name} pins the certificate the node reported`, () => {
      expect(run(hysteriaEndpoint(true))).toMatch(pinned);
    });

    it(`${name} without a report is the unpinned endpoint, with no flag that skips verification`, () => {
      const out = run(hysteriaEndpoint(false));
      expect(out).not.toMatch(pinned);
      expect(out).not.toMatch(unchecked);
    });
  }

  it('the sing-box config keeps `insecure` off with the pin', () => {
    const cfg = JSON.parse(buildSingboxJson([hysteriaEndpoint(true)])) as {
      outbounds: { type: string; tls?: Record<string, unknown> }[];
    };
    const hy = cfg.outbounds.find((o) => o.type === 'hysteria2')!;
    expect(hy.tls!.insecure).toBeUndefined();
    expect(hy.tls!.certificate).toEqual(['-----BEGIN CERTIFICATE-----', 'MIIB', '-----END CERTIFICATE-----']);
  });
});
