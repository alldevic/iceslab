import { describe, expect, it } from 'vitest';
import { buildNaiveUri, type NaiveUriOpts } from './uri.js';

const baseOpts: NaiveUriOpts = {
  username: 'alice',
  password: 'secret-password',
  host: 'n1.example.com',
  port: 443,
  name: 'eu-1',
};

describe('buildNaiveUri', () => {
  it('emits a naive+https:// scheme with user:pass@host:port', () => {
    const uri = buildNaiveUri(baseOpts);
    expect(uri).toMatch(/^naive\+https:\/\/alice:secret-password@n1\.example\.com:443\?/);
  });

  it('enables padding by default', () => {
    expect(buildNaiveUri(baseOpts)).toContain('padding=true');
  });

  it('omits the query entirely when padding=false', () => {
    const uri = buildNaiveUri({ ...baseOpts, padding: false });
    expect(uri).not.toContain('padding');
    expect(uri).toMatch(/@n1\.example\.com:443#eu-1$/);
  });

  it('URL-encodes username and password', () => {
    const uri = buildNaiveUri({ ...baseOpts, username: 'user@home', password: 'pa:ss/word' });
    expect(uri).toContain('user%40home');
    expect(uri).toContain('pa%3Ass%2Fword');
  });

  it('URL-encodes the name fragment', () => {
    const uri = buildNaiveUri({ ...baseOpts, name: 'eu node #1' });
    expect(uri).toMatch(/#eu%20node%20%231$/);
  });

  it('uses non-default port when provided', () => {
    const uri = buildNaiveUri({ ...baseOpts, port: 8443 });
    expect(uri).toContain(':8443?');
  });
});

describe('buildNaiveUri IPv6', () => {
  it('brackets an IPv6 host', () => {
    expect(buildNaiveUri({ ...baseOpts, host: '2001:db8::1' })).toContain('@[2001:db8::1]:443?');
  });
});
