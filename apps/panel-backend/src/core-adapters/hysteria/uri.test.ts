import { describe, expect, it } from 'vitest';
import { buildHysteriaUri } from './uri.js';

describe('buildHysteriaUri', () => {
  const base = { password: 'pw', port: 443, name: 'eu-1' };

  it('joins a name as host:port', () => {
    expect(buildHysteriaUri({ ...base, host: 'n.example.com' })).toMatch(
      /^hysteria2:\/\/pw@n\.example\.com:443\/\?/,
    );
  });

  it('brackets an IPv6 host, bare or bracketed on input', () => {
    expect(buildHysteriaUri({ ...base, host: '2001:db8::1' })).toMatch(/^hysteria2:\/\/pw@\[2001:db8::1\]:443\/\?/);
    expect(buildHysteriaUri({ ...base, host: '[2001:db8::1]' })).toMatch(/^hysteria2:\/\/pw@\[2001:db8::1\]:443\/\?/);
  });
});
