import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MULTI_INBOUND_ADAPTER_KEYS,
  adapterKeyForProfile,
  nativeEngineForProtocol,
} from './node-adapter-keys.js';

/**
 * The panel refuses to deploy two profiles onto one node's single-inbound core
 * (assertNodeCoreFree). That refusal is only as true as its idea of WHICH cores
 * hold one - and "holds one" is a property of the node's Go code, not of the
 * panel.
 *
 * So neither half is restated here. The set of multi-inbound adapters is
 * derived from the node's own `core.InboundReconciler` implementations, and the
 * native-engine map from `dto.NativeEngine`. The day an adapter learns to hold
 * several - which upstream would do by implementing `RetainInbounds`, the same
 * way xray did - this test fails and names it, instead of the panel quietly
 * going on refusing a deploy the node could now serve. It fails in the other
 * direction too: an adapter that loses the interface while the panel still
 * believes it multiplexes is the silent eviction this whole guard exists for.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const coreDir = `${repoRoot}apps/node/internal/core`;

/** Strip comments: every claim below must come from code, not from prose. */
function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\/.*$/gm, '');
}

/**
 * Read one adapter package's (Name, Engine) pair out of its `func (a *Adapter)`
 * accessors. A package whose accessors return a field rather than a literal
 * (amneziawg, singbox) serves several protocols and is reported as such.
 */
function adapterIdentity(pkg: string): { names: string[]; engines: string[] } {
  const src = code(`${coreDir}/${pkg}/adapter.go`);
  const literal = (fn: 'Name' | 'Engine'): string[] => {
    const m = src.match(
      new RegExp(`func \\(a \\*Adapter\\) ${fn}\\(\\) string \\{ return ([^}]+) \\}`),
    );
    if (!m) throw new Error(`${pkg}: no single-line ${fn}() the mirror can read`);
    const body = m[1].trim();
    if (body === 'Name') {
      // `const Name = "mieru"` in the same package.
      const c = src.match(/const Name = "([^"]+)"/);
      if (!c) throw new Error(`${pkg}: Name() returns Name but no const Name`);
      return [c[1]];
    }
    const quoted = body.match(/^"([^"]+)"$/);
    if (quoted) return [quoted[1]];
    // A field (a.cfg.Protocol / a.protocol): the package is instantiated once
    // per protocol it serves, so every one of them is its own adapter object.
    return [];
  };
  return { names: literal('Name'), engines: literal('Engine') };
}

/** Packages under internal/core that define a CoreAdapter. */
function adapterPackages(): string[] {
  return readdirSync(coreDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'subprocess')
    .map((e) => e.name)
    .sort();
}

/** Adapter packages implementing core.InboundReconciler - the multi-inbound ones. */
function reconcilerPackages(): string[] {
  return adapterPackages().filter((pkg) =>
    /func \(a \*Adapter\) RetainInbounds\(/.test(code(`${coreDir}/${pkg}/adapter.go`)),
  );
}

/** The node's native-engine map, read out of dto.NativeEngine's switch. */
function nodeNativeEngines(): Record<string, string> {
  const src = code(`${repoRoot}apps/node/internal/dto/dto.go`);
  const fn = src.match(/func NativeEngine\(p ProtocolName\) EngineName \{([\s\S]*?)\n\}/);
  if (!fn) throw new Error('dto.NativeEngine is no longer shaped the way this test reads it');
  const consts = new Map<string, string>();
  const decl = /(Protocol[A-Za-z]+|Engine[A-Za-z]+)\s+(?:ProtocolName|EngineName)\s*=\s*"([^"]+)"/g;
  for (const m of src.matchAll(decl)) {
    consts.set(m[1], m[2]);
  }
  const out: Record<string, string> = {};
  for (const c of fn[1].matchAll(/case ([^:]+):\s*return (Engine[A-Za-z]+)/g)) {
    const engine = consts.get(c[2].trim());
    if (!engine) throw new Error(`unknown engine constant ${c[2]}`);
    for (const p of c[1].split(',')) {
      const proto = consts.get(p.trim());
      if (!proto) throw new Error(`unknown protocol constant ${p.trim()}`);
      out[proto] = engine;
    }
  }
  return out;
}

describe('the panel’s picture of the node’s adapters, read from the node', () => {
  it('finds the adapter packages at all', () => {
    // The control. A readdir that returned nothing, or a regex that matched
    // nothing, would make every case below vacuously true.
    const pkgs = adapterPackages();
    expect(pkgs).toContain('xray');
    expect(pkgs).toContain('mtproto');
    expect(pkgs.length).toBeGreaterThanOrEqual(7);
  });

  it('agrees with the node on which adapters hold SEVERAL inbounds', () => {
    const keys = new Set<string>();
    for (const pkg of reconcilerPackages()) {
      const { names, engines } = adapterIdentity(pkg);
      expect(
        names.length && engines.length,
        `${pkg} implements RetainInbounds but does not name a single (protocol, engine) pair; ` +
          `the panel's MULTI_INBOUND_ADAPTER_KEYS cannot describe it and needs widening by hand`,
      ).toBeTruthy();
      for (const n of names) for (const e of engines) keys.add(`${n}|${e}`);
    }
    expect(
      [...keys].sort(),
      'an adapter gained or lost core.InboundReconciler on the node; ' +
        'MULTI_INBOUND_ADAPTER_KEYS in node-adapter-keys.ts must move with it, or the panel ' +
        'either refuses a deploy the node can now serve, or allows one it silently evicts',
    ).toEqual([...MULTI_INBOUND_ADAPTER_KEYS].sort());
  });

  it('agrees with the node on which core serves a protocol by default', () => {
    const node = nodeNativeEngines();
    expect(Object.keys(node).length).toBeGreaterThan(0);
    for (const [protocol, engine] of Object.entries(node)) {
      expect(
        nativeEngineForProtocol(protocol),
        `the node dispatches an unpinned ${protocol} inbound to the ${engine} adapter; ` +
          `the panel thinks ${nativeEngineForProtocol(protocol)}`,
      ).toBe(engine);
    }
    // And the default arm: a protocol the switch does not name is served by the
    // core of its own name, which is what makes mtproto|mtproto a key at all.
    expect(node.mtproto).toBeUndefined();
    expect(nativeEngineForProtocol('mtproto')).toBe('mtproto');
  });

  it('keys a profile the way core.AdapterKey keys an inbound', () => {
    const src = code(`${coreDir}/adapter.go`);
    const m = src.match(
      /func AdapterKey\(protocol, engine string\) string \{ return ([^}]+) \}/,
    );
    if (!m) throw new Error('core.AdapterKey is no longer shaped the way this test reads it');
    // The node joins the pair with a literal separator; the panel must use the
    // same one, or two strings that describe the same adapter never compare equal.
    const sep = m[1].match(/"([^"]*)"/);
    expect(sep, 'AdapterKey no longer joins with a literal separator').not.toBeNull();
    expect(m[1].trim().startsWith('protocol')).toBe(true);
    expect(adapterKeyForProfile('mtproto', null)).toBe(`mtproto${sep![1]}mtproto`);
    expect(adapterKeyForProfile('shadowsocks', null)).toBe(`shadowsocks${sep![1]}xray`);
    expect(adapterKeyForProfile('xray', 'singbox')).toBe(`xray${sep![1]}singbox`);
  });
});
