import { describe, expect, it } from 'vitest';
import { stripInapplicableTransportFields } from './xray-transport-fields.js';

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
