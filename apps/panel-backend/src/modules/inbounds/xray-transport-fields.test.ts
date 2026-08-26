import { describe, expect, it } from 'vitest';
import { stripInapplicableTransportFields } from './xray-transport-fields.js';
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
  realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
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
    expect(out.realityPrivateKey).toBe('YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE');
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
  // Measured against xray 26.3.27 on a live node, not inferred: `grpc + Vision`
  // LOADS, and then rejects clients ("client flow is empty") because every link
  // the panel emits drops the flow for gRPC. `ws`/`kcp` never get that far -
  // xray refuses a REALITY inbound on them outright - which is why gRPC is the
  // case this rule is actually for.
  it('blanks flow when the transport cannot carry Vision', () => {
    expect(stripInapplicableTransportFields({ network: 'grpc', flow: 'xtls-rprx-vision' }).flow).toBe('');
    expect(stripInapplicableTransportFields({ network: 'ws', flow: 'xtls-rprx-vision' }).flow).toBe('');
    expect(stripInapplicableTransportFields({ network: 'kcp', flow: 'xtls-rprx-vision' }).flow).toBe('');
    expect(
      stripInapplicableTransportFields({ network: 'httpupgrade', flow: 'xtls-rprx-vision' }).flow,
    ).toBe('');
  });

  it('keeps it where Vision belongs', () => {
    expect(stripInapplicableTransportFields({ network: 'raw', flow: 'xtls-rprx-vision' }).flow).toBe(
      'xtls-rprx-vision',
    );
    expect(
      stripInapplicableTransportFields({ network: 'xhttp', flow: 'xtls-rprx-vision' }).flow,
    ).toBe('xtls-rprx-vision');
  });

  it('still returns the same object when there is nothing to change', () => {
    // The identity guarantee this file already made, now that `flow` can also
    // trigger a rewrite: an unchanged profile must keep its stored JSON
    // byte-stable, or every save churns the row.
    const untouched = { network: 'grpc', serviceName: 'svc', flow: '' };
    expect(stripInapplicableTransportFields(untouched)).toBe(untouched);
    const alsoUntouched = { network: 'raw', flow: 'xtls-rprx-vision' };
    expect(stripInapplicableTransportFields(alsoUntouched)).toBe(alsoUntouched);
  });
});

/**
 * The same measured fact is spent in three places, and it has to be one fact.
 *
 * The server end blanks `flow` outside the Vision-carrying set (this file).
 * The client end drops it from the URI (`core-adapters/xray/uri.ts`). The
 * admin form warns about it (`panel-frontend/src/lib/recipes.ts`, tied to this
 * module by its own test). Each of the first two is pinned against a
 * hand-written list of networks; neither is pinned against the OTHER.
 *
 * A disagreement is the failure both files quote from the field, in whichever
 * direction it goes: a URI carrying a flow the server blanked hits "the client
 * flow is not empty", a URI missing one the server kept hits "account <uuid>
 * is rejected since the client flow is empty. Note that the pure TLS proxy has
 * certain TLS in TLS characters." Every user of the profile, on a save that
 * looked ordinary.
 *
 * So the two are asked the same question here, with no list in between.
 */
describe('the client URI and the server config agree on where Vision goes', () => {
  const NETWORKS = ['raw', 'xhttp', 'grpc', 'ws', 'kcp', 'httpupgrade'];

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
      // The transports that need one; an absent value is not what is under
      // test here and would make some builders emit a different shape.
      path: '/p',
      serviceName: 'svc',
    });
    const clientAsks = uri.includes('flow=');
    expect(clientAsks, serverKeeps
      ? `the server serves Vision on ${network} and the client URI does not ask for it`
      : `the client URI asks for Vision on ${network} and the server blanks it`).toBe(serverKeeps);
  });

  it('is not asking a question with one answer', () => {
    // The control. If every network answered the same way, the case above
    // would pass against a builder that had simply stopped emitting `flow`.
    const keeps = NETWORKS.filter(
      (n) => stripInapplicableTransportFields({ network: n, flow: 'xtls-rprx-vision' }).flow !== '',
    );
    expect(keeps.length).toBeGreaterThan(0);
    expect(keeps.length).toBeLessThan(NETWORKS.length);
  });
});
