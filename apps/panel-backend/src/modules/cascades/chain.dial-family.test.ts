import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderChainConfig, type ChainRenderInput } from './chain.config.js';
import { buildCascadeConfigs, LINK_PORT_BASE, type LinkCred } from './cascade.config.js';
import { dialFamilyOf } from './dial-family.js';
import { transitInput } from './chain.config.test.js';

/**
 * A-111, the IPv6 part. The next hop's firewall lets a leg in only from the
 * previous hop's address as the panel knows it. A previous hop named by an
 * IPv4 literal, dialling a next hop named by a hostname with an AAAA record,
 * could leave over IPv6 and be dropped by ufw without a word. So such a leg is
 * dialled over IPv4: sing-box `domain_resolver.strategy`, xray
 * `sockopt.domainStrategy`.
 */
const SINGBOX_BIN = process.env.SINGBOX_BIN ?? ['/usr/local/bin/sing-box'].find((p) => existsSync(p)) ?? '';

type Ob = Record<string, unknown> & { tag?: string };
const outs = (cfg: unknown) => (cfg as { outbounds: Ob[] }).outbounds;

describe('dialFamilyOf', () => {
  it('pins to the literal family of this node, only towards a hostname', () => {
    expect(dialFamilyOf('10.0.0.1', 'exit.example.com')).toBe(4);
    expect(dialFamilyOf('2001:db8::1', 'exit.example.com')).toBe(6);
    expect(dialFamilyOf('10.0.0.1', '10.0.0.2')).toBeUndefined();
    expect(dialFamilyOf('entry.example.com', 'exit.example.com')).toBeUndefined();
    expect(dialFamilyOf(undefined, 'exit.example.com')).toBeUndefined();
  });
});

describe('the chain leg', () => {
  const named: ChainRenderInput = {
    ...transitInput,
    selfHost: '10.0.0.1',
    out: (transitInput.out ?? []).map((l) => ({ ...l, host: 'next.example.com' })),
  };

  it('to a hostname, from an IPv4 literal: dialled IPv4 only, with the resolver declared', () => {
    const cfg = renderChainConfig(named) as { dns?: { servers: Ob[] } };
    const legs = outs(cfg).filter((o) => o.server === 'next.example.com');
    expect(legs.length).toBeGreaterThan(0);
    for (const l of legs) expect(l.domain_resolver).toEqual({ server: 'leg-dns', strategy: 'ipv4_only' });
    expect(cfg.dns?.servers).toEqual([{ type: 'local', tag: 'leg-dns' }]);
  });

  it('to a literal, or from a hostname: nothing pinned, no dns section', () => {
    const literal: ChainRenderInput = {
      ...transitInput,
      selfHost: '10.0.0.1',
      out: (transitInput.out ?? []).map((l, i) => ({ ...l, host: `10.0.1.${i + 1}` })),
    };
    for (const input of [literal, { ...named, selfHost: 'transit.example.com' }, { ...named, selfHost: undefined }]) {
      const cfg = renderChainConfig(input) as { dns?: unknown };
      expect(outs(cfg).some((o) => 'domain_resolver' in o)).toBe(false);
      expect(cfg.dns).toBeUndefined();
    }
  });

  it.skipIf(!SINGBOX_BIN)('is a config sing-box 1.13 loads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iceslab-dial-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify(renderChainConfig(named)));
    expect(() => execFileSync(SINGBOX_BIN, ['check', '-c', file], { encoding: 'utf8' })).not.toThrow();
  });
});

describe('the legacy xray leg', () => {
  it('to a hostname, from an IPv4 literal: ForceIPv4 on the link-out', () => {
    const cred = { protocol: 'shadowsocks', port: LINK_PORT_BASE, method: '2022-blake3-aes-128-gcm', psk: 'a'.repeat(24) } as unknown as LinkCred;
    const [entry] = buildCascadeConfigs(
      [
        { nodeId: 'e', position: 0, nodeHost: '10.0.0.1' },
        { nodeId: 'x', position: 1, nodeHost: 'exit.example.com' },
      ] as never,
      [cred],
    );
    const linkOut = entry!.outbounds.find((o) => (o as Ob).protocol === 'shadowsocks') as Ob;
    expect((linkOut.streamSettings as { sockopt: Record<string, unknown> }).sockopt.domainStrategy).toBe('ForceIPv4');
  });
});
