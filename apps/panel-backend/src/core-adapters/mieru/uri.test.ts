import { describe, expect, it } from 'vitest';
import { buildMieruProfileJson, buildMieruUri } from './uri.js';

describe('buildMieruProfileJson', () => {
  it('shapes a single-server profile with TCP+UDP bindings by default', () => {
    const profile = buildMieruProfileJson({
      profileName: 'eu-1',
      username: 'alice',
      password: 'pw-a',
      host: 'mieru.example.com',
      port: 2012,
    });
    const p = profile.profiles[0];
    expect(p.profileName).toBe('eu-1');
    expect(p.user.name).toBe('alice');
    expect(p.user.password).toBe('pw-a');
    expect(p.servers[0].ipAddress).toBe('mieru.example.com');
    expect(p.servers[0].portBindings).toEqual([
      { port: 2012, protocol: 'TCP' },
      { port: 2012, protocol: 'UDP' },
    ]);
    expect(p.mtu).toBe(1400);
  });

  it('honours protocols override (e.g. TCP-only)', () => {
    const p = buildMieruProfileJson({
      profileName: 'tcp-only',
      username: 'u',
      password: 'p',
      host: 'h',
      port: 2012,
      protocols: ['TCP'],
    }).profiles[0];
    expect(p.servers[0].portBindings).toEqual([{ port: 2012, protocol: 'TCP' }]);
  });

  it('honours mtu override', () => {
    const p = buildMieruProfileJson({
      profileName: 'mtu',
      username: 'u',
      password: 'p',
      host: 'h',
      port: 2012,
      mtu: 1280,
    }).profiles[0];
    expect(p.mtu).toBe(1280);
  });
});

describe('buildMieruUri', () => {
  it('emits mieru:// pseudo-scheme with userinfo + name fragment', () => {
    const uri = buildMieruUri({
      username: 'alice',
      password: 'pw-a',
      host: 'mieru.example.com',
      port: 2012,
      mtu: 1400,
      name: 'eu-1',
    });
    expect(uri.startsWith('mieru://pw-a@')).toBe(true);
    expect(uri).toContain('@mieru.example.com:2012');
    expect(uri).toContain('mtu=1400');
    expect(uri).toContain('user=alice');
    expect(uri.endsWith('#eu-1')).toBe(true);
  });

  it('URL-encodes special chars in password', () => {
    const uri = buildMieruUri({
      username: 'u',
      password: 'pa:s/w',
      host: 'h',
      port: 1,
      name: 'n',
    });
    // : and / must be encoded in userinfo
    expect(uri).toContain('pa%3As%2Fw@');
  });
});

describe('buildMieruUri IPv6', () => {
  it('brackets an IPv6 host', () => {
    const uri = buildMieruUri({ username: 'u', password: 'p', host: '2001:db8::1', port: 2012, mtu: 1400, name: 'n' });
    expect(uri).toContain('p@[2001:db8::1]:2012');
  });
});
