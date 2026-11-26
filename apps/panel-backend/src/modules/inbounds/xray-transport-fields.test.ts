import { describe, expect, it } from 'vitest';
import { NETWORKS_CARRYING_VISION, stripInapplicableTransportFields } from './xray-transport-fields.js';
import { buildVlessRealityUri } from '../../core-adapters/xray/uri.js';

/** The profile that prompted this: gRPC settings still sitting in an XHTTP
 *  profile, months after the transport was switched. */
const xhttpWithGrpcLeftovers = {
  network: 'xhttp',
  path: '/cr4t5j8w',
  xhttpMode: 'auto',
  xhttpPaddingBytes: '',
  serviceName: 'GunService',
  grpcMultiMode: false,
  realityPrivateKey: 'private-key-material',
  realityPublicKey: 'public-key-material',
  security: 'reality',
};

describe('stripInapplicableTransportFields', () => {
  it('drops gRPC settings from an XHTTP profile', () => {
    const out = stripInapplicableTransportFields(xhttpWithGrpcLeftovers);
    expect(out).not.toHaveProperty('serviceName');
    expect(out).not.toHaveProperty('grpcMultiMode');
  });

  it('keeps the settings the chosen transport uses', () => {
    const out = stripInapplicableTransportFields(xhttpWithGrpcLeftovers);
    expect(out.path).toBe('/cr4t5j8w');
    expect(out.xhttpMode).toBe('auto');
    expect(out.xhttpPaddingBytes).toBe('');
  });

  // The whole point of dropping rather than ignoring: a switch back must not
  // resurrect a value nobody remembers typing.
  it('does not carry a value across a switch away and back', () => {
    const asGrpc = { network: 'grpc', serviceName: 'secret-svc', grpcMultiMode: true };
    const asXhttp = stripInapplicableTransportFields({ ...asGrpc, network: 'xhttp' });
    const backToGrpc = stripInapplicableTransportFields({ ...asXhttp, network: 'grpc' });
    expect(backToGrpc).not.toHaveProperty('serviceName');
    expect(backToGrpc).not.toHaveProperty('grpcMultiMode');
  });

  // Identity material outlives a transport change: clients carry `pbk` in every
  // link already issued, and an operator-supplied certificate cannot be
  // regenerated at all.
  it('never touches REALITY or TLS material', () => {
    const out = stripInapplicableTransportFields({
      ...xhttpWithGrpcLeftovers,
      tlsCert: 'cert',
      tlsKey: 'key',
      tlsServerName: 'node.example',
    });
    expect(out.realityPrivateKey).toBe('private-key-material');
    expect(out.realityPublicKey).toBe('public-key-material');
    expect(out.tlsCert).toBe('cert');
    expect(out.tlsKey).toBe('key');
    expect(out.tlsServerName).toBe('node.example');
  });

  it('drops path and host on a transport that has no path', () => {
    const out = stripInapplicableTransportFields({
      network: 'grpc',
      serviceName: 'svc',
      path: '/left-over',
      host: 'left-over.example',
    });
    expect(out).not.toHaveProperty('path');
    expect(out).not.toHaveProperty('host');
    expect(out.serviceName).toBe('svc');
  });

  it('strips everything transport-specific on raw and kcp', () => {
    for (const network of ['raw', 'kcp']) {
      const out = stripInapplicableTransportFields({
        network,
        path: '/p',
        host: 'h',
        serviceName: 's',
        xhttpMode: 'auto',
      });
      expect(Object.keys(out)).toEqual(['network']);
    }
  });

  // A missing `network` means the schema default, `raw`. Guessing otherwise
  // would keep leftovers alive exactly where the operator sees the fewest
  // fields in the form.
  it('treats a missing network as raw', () => {
    const out = stripInapplicableTransportFields({ serviceName: 'svc' });
    expect(out).not.toHaveProperty('serviceName');
  });

  // Byte-stable storage: a save that changes nothing must not rewrite the JSON.
  it('returns the same object when there is nothing to drop', () => {
    const cfg = { network: 'grpc', serviceName: 'svc', grpcMultiMode: false };
    expect(stripInapplicableTransportFields(cfg)).toBe(cfg);
  });
});

describe('Vision does not survive a transport switch', () => {
  // Measured on xray 26.3.27: `grpc + Vision` LOADS and then rejects every
  // client ("client flow is empty"), because every link the panel emits drops
  // the flow for gRPC. ws/kcp under REALITY never get that far, but TLS on them
  // does, so the sweep covers them too.
  it('blanks flow where the transport cannot carry Vision', () => {
    for (const network of ['grpc', 'ws', 'kcp', 'httpupgrade']) {
      expect(
        stripInapplicableTransportFields({ network, flow: 'xtls-rprx-vision' }).flow,
        network,
      ).toBe('');
    }
  });

  it('keeps it on raw and xhttp', () => {
    for (const network of ['raw', 'xhttp']) {
      expect(
        stripInapplicableTransportFields({ network, flow: 'xtls-rprx-vision' }).flow,
        network,
      ).toBe('xtls-rprx-vision');
    }
  });

  it('a missing network is raw, so flow stays', () => {
    expect(stripInapplicableTransportFields({ flow: 'xtls-rprx-vision' }).flow).toBe(
      'xtls-rprx-vision',
    );
  });

  // Identity guarantee, now that `flow` can also trigger a rewrite: an
  // unchanged profile keeps its stored JSON byte-stable.
  it('still returns the same object when there is nothing to change', () => {
    const untouched = { network: 'grpc', serviceName: 'svc', flow: '' };
    expect(stripInapplicableTransportFields(untouched)).toBe(untouched);
    const alsoUntouched = { network: 'raw', flow: 'xtls-rprx-vision' };
    expect(stripInapplicableTransportFields(alsoUntouched)).toBe(alsoUntouched);
    const noFlow = { network: 'ws', path: '/p' };
    expect(stripInapplicableTransportFields(noFlow)).toBe(noFlow);
  });
});

/**
 * The same measured fact is spent in two places and it has to be one fact: the
 * server blanks `flow` outside NETWORKS_CARRYING_VISION, the client URI drops it
 * (`core-adapters/xray/uri.ts`). A disagreement is the failure xray quotes in
 * either direction ("client flow is not empty" / "client flow is empty"), for
 * every user of the profile, after a save that looked ordinary. So the two are
 * asked the same question here, with no hand-written list in between.
 */
describe('the client URI and the server config agree on where Vision goes', () => {
  const NETWORKS = ['raw', 'xhttp', 'grpc', 'ws', 'kcp', 'httpupgrade'] as const;

  it.each(NETWORKS)('%s', (network) => {
    const serverKeeps =
      stripInapplicableTransportFields({ network, flow: 'xtls-rprx-vision' }).flow !== '';
    const uri = buildVlessRealityUri({
      uuid: '11111111-2222-3333-4444-555555555555',
      host: 'n1.example.com',
      port: 443,
      publicKey: 'pubkey-base64url',
      shortId: 'abc123',
      sni: 'www.cloudflare.com',
      name: 'agreement',
      network,
      path: '/p',
      serviceName: 'svc',
    });
    expect(
      uri.includes('flow='),
      serverKeeps
        ? `the server serves Vision on ${network} and the client URI does not ask for it`
        : `the client URI asks for Vision on ${network} and the server blanks it`,
    ).toBe(serverKeeps);
  });

  it('is not asking a question with one answer', () => {
    // Control: a builder that simply stopped emitting `flow` would pass above.
    const keeps = NETWORKS.filter(
      (n) => stripInapplicableTransportFields({ network: n, flow: 'xtls-rprx-vision' }).flow !== '',
    );
    expect(keeps.length).toBeGreaterThan(0);
    expect(keeps.length).toBeLessThan(NETWORKS.length);
    expect(keeps).toEqual([...NETWORKS_CARRYING_VISION]);
  });
});
