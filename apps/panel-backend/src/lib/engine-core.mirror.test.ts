import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_BINARIES, ENGINE_CORE, type CoreName } from '@iceslab/shared';

/**
 * Every engine a node can report must be a key of ENGINE_CORE, and the panel
 * must not have to guess which one.
 *
 * `GET /api/nodes/:id/cores` compares what a node runs against what the panel
 * pins, and it picks the artefact by the ENGINE the node names, because a
 * protocol can be served by more than one core. An engine missing from this map
 * does not fail: it falls through to PROTOCOL_CORE and prints the version of a
 * DIFFERENT core in the "should be" column. That happened the day mtprotoproxy
 * shipped — its row carried mtg's pinned 2.2.8 — and nothing said so, because
 * the row looked complete.
 *
 * So the map is checked against the node's own source rather than against this
 * comment: the day an adapter is added, or renames its engine, this fails and
 * names it.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const coreDir = `${repoRoot}apps/node/internal/core`;

/** Strip comments: every claim below must come from code, not from prose. */
function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\/.*$/gm, '');
}

/**
 * The engine names the node's adapters return, as far as they can be read off
 * the source.
 *
 * An adapter whose `Engine()` returns a FIELD (amneziawg, which is instantiated
 * once per wg flavour) names no literal here; those engines are the protocol
 * names and are covered by the protocol side of the map. What this reads is
 * every literal — including one behind a package-level `const`, which is how
 * mtprotoproxy spells it.
 */
function nodeEngineLiterals(): { pkg: string; engine: string }[] {
  const out: { pkg: string; engine: string }[] = [];
  const pkgs = readdirSync(coreDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'subprocess')
    .map((e) => e.name)
    .sort();
  for (const pkg of pkgs) {
    const src = code(`${coreDir}/${pkg}/adapter.go`);
    const m = src.match(/func \(a \*Adapter\) Engine\(\) string \{ return ([^}]+) \}/);
    if (!m) throw new Error(`${pkg}: no single-line Engine() the mirror can read`);
    const body = m[1]!.trim();
    const quoted = body.match(/^"([^"]+)"$/);
    if (quoted) {
      out.push({ pkg, engine: quoted[1]! });
      continue;
    }
    if (/^[A-Za-z]\w*$/.test(body)) {
      // A package-level constant, declared either on its own (`const Engine =
      // "x"`) or inside a `const (...)` block, where it is written `Engine =
      // "x"` with no keyword. Both spellings are in the tree, and reading only
      // the first is how this check silently stopped covering mtprotoproxy —
      // the very adapter it was written for.
      const c = src.match(new RegExp(`(?:^|\\n)\\s*(?:const\\s+)?${body}\\s+=\\s+"([^"]+)"`));
      if (!c) {
        throw new Error(
          `${pkg}: Engine() returns the constant ${body}, and this mirror cannot find its value; ` +
            `resolve it here rather than skipping, or the check passes by finding nothing`,
        );
      }
      out.push({ pkg, engine: c[1]! });
      continue;
    }
    // A field: this package serves several protocols and is one adapter per
    // flavour. Its engine names are its protocol names, checked below.
  }
  return out;
}

describe('the panel’s engine → artefact map, read from the node', () => {
  it('finds engines at all', () => {
    // The control: a readdir or a regex that matched nothing would make every
    // case below vacuously true.
    const engines = nodeEngineLiterals();
    expect(engines.map((e) => e.engine)).toContain('xray');
    expect(engines.length).toBeGreaterThanOrEqual(6);
  });

  it('knows every engine an adapter reports', () => {
    for (const { pkg, engine } of nodeEngineLiterals()) {
      expect(
        Object.prototype.hasOwnProperty.call(ENGINE_CORE, engine),
        `the ${pkg} adapter reports engine "${engine}" and ENGINE_CORE has no entry for it; ` +
          `the cores view will fall back to PROTOCOL_CORE and print another core's pinned ` +
          `version beside it`,
      ).toBe(true);
    }
  });

  it('names a core this manifest pins, or names nothing on purpose', () => {
    for (const [engine, core] of Object.entries(ENGINE_CORE)) {
      if (core === null) continue;
      expect(
        Object.prototype.hasOwnProperty.call(CORE_BINARIES, core),
        `engine ${engine} points at ${core}, which the manifest does not pin`,
      ).toBe(true);
    }
  });

  it('gives the two mtproto engines two different artefacts', () => {
    // The case that made this file: one protocol, two programs. Reading either
    // row must not show the other's version.
    expect(ENGINE_CORE.mtproto).toBe<CoreName>('mtg');
    expect(ENGINE_CORE.mtprotoproxy).toBe<CoreName>('mtprotoproxy');
    expect(ENGINE_CORE.mtproto).not.toBe(ENGINE_CORE.mtprotoproxy);
  });
});
