import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderChainConfig, TPROXY_IN_TAG, TPROXY6_IN_TAG, type ChainRenderInput } from './chain.config.js';
import { CHAIN_TPROXY_PORT } from './chain.ports.js';
import { chainPoliciesOf } from './chain-policy.js';

/**
 * 18.12: the second tproxy inbound, on `::1`, for an entry whose interface
 * carries IPv6 in the tunnel. Without the flag the config is the one of 18.9
 * and before, byte for byte.
 */
const SINGBOX_BIN =
  process.env.SINGBOX_BIN ?? ['/usr/local/bin/sing-box', '/usr/bin/sing-box'].find((p) => existsSync(p)) ?? '';

const SS_PSK = 'aWNlc2xhYi1jaGFpbi1maXh0dXJlLXBzay0wMDAwMDA=';
const entry = (tproxy: ChainRenderInput['tproxy'], over: Partial<ChainRenderInput> = {}): ChainRenderInput => ({
  role: 'entry',
  socksPassword: 'chain-socks-fixture-password-0000',
  directionTags: [0, 1],
  out: [],
  foreign: [{ tag: 1, type: 'socks', config: { server: '192.0.2.1', port: 1080 } }],
  tproxy,
  ...over,
});

type Cfg = { inbounds: Record<string, unknown>[]; route: { rules: Record<string, unknown>[] } };

describe('the tproxy inbound on ::1', () => {
  it('without the flag the config is byte for byte the one of before', () => {
    const before = JSON.stringify(renderChainConfig(entry({ ordinal: 0 })));
    expect(JSON.stringify(renderChainConfig(entry({ ordinal: 0, ipv6: false })))).toBe(before);
    expect(before).not.toContain('::1');
    expect(before).not.toContain(TPROXY6_IN_TAG);
  });

  it('with it: a second tproxy inbound on ::1, the same port, its own tag, right after the first', () => {
    const cfg = renderChainConfig(entry({ ordinal: 0, ipv6: true })) as Cfg;
    const tp = cfg.inbounds.filter((i) => i.type === 'tproxy');
    expect(tp).toEqual([
      { type: 'tproxy', tag: TPROXY_IN_TAG, listen: '127.0.0.1', listen_port: CHAIN_TPROXY_PORT },
      { type: 'tproxy', tag: TPROXY6_IN_TAG, listen: '::1', listen_port: CHAIN_TPROXY_PORT },
    ]);
    expect(new Set(cfg.inbounds.map((i) => i.tag)).size).toBe(cfg.inbounds.length);
  });

  it('both inbounds meet the same rules: the Auto line, and the entry policy gate', () => {
    const { policies, ruleSets } = chainPoliciesOf([{ ordinal: 2, blockDomains: ['ads.example'], directDomains: ['domain:gosuslugi.ru'] }]);
    const base = entry({ ordinal: 2 }, { policies, ruleSets: ruleSets.map((r) => ({ tag: r.tag, path: `/tmp/${r.tag}.json` })) });
    const v4 = renderChainConfig(base) as Cfg;
    const v6 = renderChainConfig({ ...base, tproxy: { ordinal: 2, ipv6: true } }) as Cfg;
    const both = [TPROXY_IN_TAG, TPROXY6_IN_TAG];
    // Every rule that named the listener names both now; nothing else changed.
    const onListener = (c: Cfg) => c.route.rules.filter((r) => (r.inbound as string[] | undefined)?.includes(TPROXY_IN_TAG));
    expect(onListener(v4).length).toBeGreaterThan(1);
    expect(onListener(v6).map((r) => r.inbound)).toEqual(onListener(v6).map(() => both));
    const widen = (r: Record<string, unknown>) =>
      (r.inbound as string[] | undefined)?.length === 1 && (r.inbound as string[])[0] === TPROXY_IN_TAG ? { ...r, inbound: both } : r;
    expect(v6.route.rules).toEqual(v4.route.rules.map(widen));
    expect(v6.route.rules).toContainEqual({ inbound: both, action: 'route', outbound: 'out-d0' });
    // And no rule names the IPv6 tag alone: it is never routed differently.
    expect(v6.route.rules.filter((r) => JSON.stringify(r.inbound) === JSON.stringify([TPROXY6_IN_TAG]))).toEqual([]);
  });

  it('the DNS hijack stays on the socks listeners: the tunnel DNS over IPv6 goes on like any UDP', () => {
    const cfg = renderChainConfig(entry({ ordinal: 0, ipv6: true })) as Cfg;
    expect(cfg.route.rules[1]).toEqual({ protocol: 'dns', inbound: ['in-d0', 'in-d1'], action: 'hijack-dns' });
  });

  it('an entry with no TPROXY has no IPv6 inbound, flag or not', () => {
    const cfg = renderChainConfig(entry(undefined)) as Cfg;
    expect(cfg.inbounds.some((i) => i.type === 'tproxy')).toBe(false);
  });

  it.runIf(SINGBOX_BIN)('is a config sing-box accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iceslab-tproxy6-'));
    const file = join(dir, 'config.json');
    const cfg = renderChainConfig(
      entry(
        { ordinal: 0, ipv6: true },
        {
          foreign: [],
          out: [
            {
              tag: 1,
              host: '192.0.2.1',
              cred: { protocol: 'shadowsocks', port: 24001, psk: SS_PSK, method: '2022-blake3-aes-256-gcm' },
            },
          ],
        },
      ),
    );
    writeFileSync(file, JSON.stringify(cfg));
    expect(() => execFileSync(SINGBOX_BIN, ['check', '-c', file], { encoding: 'utf8' })).not.toThrow();
    expect(JSON.stringify(cfg)).toContain('"listen":"::1"');
  });

  // Whether sing-box takes both inbounds on one port: two sockets, one per
  // family. TPROXY needs IP_TRANSPARENT (CAP_NET_ADMIN), which a user and
  // network namespace gives without root (`unshare -rn`); where even that is not
  // allowed the case is skipped.
  const canNetns = spawnSync('unshare', ['-rn', 'true']).status === 0;
  it.runIf(SINGBOX_BIN && canNetns)('starts both tproxy listeners on one port, IPv4 and ::1 (in a namespace)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iceslab-tproxy6-run-'));
    const file = join(dir, 'config.json');
    const cfg = renderChainConfig(
      entry(
        { ordinal: 0, ipv6: true },
        {
          foreign: [],
          out: [
            {
              tag: 1,
              host: '192.0.2.1',
              cred: { protocol: 'shadowsocks', port: 24001, psk: SS_PSK, method: '2022-blake3-aes-256-gcm' },
            },
          ],
        },
      ),
    ) as Cfg;
    cfg.inbounds = cfg.inbounds.map((i) => (i.type === 'tproxy' ? { ...i, listen_port: 25999 } : { ...i, listen_port: 0 }));
    (cfg as unknown as { log: unknown }).log = { level: 'info' };
    writeFileSync(file, JSON.stringify(cfg));
    const r = spawnSync('unshare', ['-rn', 'sh', '-c', `ip link set lo up && exec ${SINGBOX_BIN} run -c ${file}`], {
      encoding: 'utf8',
      timeout: 3000,
    });
    // Killed by the timeout: it started and kept listening. The log names both.
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toMatch(/inbound\/tproxy\[in-tproxy\]: tcp server started at 127\.0\.0\.1:25999/);
    expect(out).toMatch(/inbound\/tproxy\[in-tproxy6\]: tcp server started at \[::1\]:25999/);
    expect(out).toMatch(/inbound\/tproxy\[in-tproxy6\]: udp server started at \[::1\]:25999/);
    expect(out).not.toMatch(/FATAL/);
  });
});
