import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `PROTOCOL_OPTIONS` exists four times in this app — once exported from
 * `lib/protocols.ts` (which has its own test) and once, privately, in each of
 * the three screens that actually create or edit a node. The three private
 * copies are the ones an operator picks from; the tested one is not.
 *
 * The labels differ on purpose: the node forms group the sing-box-only cores
 * under a "sing-box" header, so repeating "(sing-box)" in the label would say
 * it twice. The VALUES may not differ. A protocol in `NodeProtocol` and absent
 * from one of these lists is a protocol that cannot be deployed from that
 * screen, and there is nothing on screen to say why — the same shape as the
 * three profile protocols the API had no branch for.
 *
 * `DEFAULT_NODE_PORT` is the same kind of thing across a language boundary: the
 * comment beside it says it is hard-coded in install-iceslab-node.sh, and that
 * sentence was the only thing holding them together.
 */

const SRC = join(import.meta.dirname, '..');
const INSTALLER = join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'install-iceslab-node.sh');

const COPIES = [
  'lib/protocols.ts',
  'components/NodeFormModal.tsx',
  'pages/NodeCreatePage.tsx',
  'pages/NodeEditPage.tsx',
] as const;

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** The `value:` entries of a `const NAME = [...]` option array. */
function optionValues(src: string, name: string, where: string): string[] {
  const at = src.indexOf(`const ${name}`);
  expect(at, `${name} not found in ${where}`).toBeGreaterThan(-1);
  const end = src.indexOf('\n];', at);
  expect(end, `${name} in ${where} is not a plain array literal any more`).toBeGreaterThan(at);
  const values = [...src.slice(at, end).matchAll(/value: '([a-z0-9]+)'/g)].map((m) => m[1]!);
  expect(values.length, `${name} in ${where} parsed to nothing`).toBeGreaterThan(5);
  return values.sort();
}

/** Members of the NodeProtocol union in api.ts. */
function nodeProtocols(): string[] {
  const src = read('lib/api.ts');
  const at = src.indexOf('export type NodeProtocol =');
  expect(at, 'the NodeProtocol union was renamed or moved').toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf(';', at));
  const names = [...body.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]!);
  expect(names.length).toBeGreaterThan(7);
  return names.sort();
}

describe('the node protocol dropdowns', () => {
  const want = nodeProtocols();

  it.each(COPIES)('%s offers every protocol a node can be', (file) => {
    expect(optionValues(read(file), 'PROTOCOL_OPTIONS', file)).toEqual(want);
  });

  /**
   * The two sing-box lists exist twice as well, and they partition the
   * dropdown: one names the cores that live under the "sing-box" header, the
   * other the native cores that additionally offer the "+ sing-box engine"
   * toggle. A protocol in neither is a native-only entry; a protocol in BOTH
   * would be shown twice and toggleable at once, which is not a state the
   * backend has a name for.
   */
  it.each(['components/NodeFormModal.tsx', 'pages/NodeCreatePage.tsx'] as const)(
    '%s keeps the two sing-box lists disjoint and inside the union',
    (file) => {
      const src = read(file);
      const list = (name: string) => {
        const m = src.match(new RegExp(`const ${name}: NodeProtocol\\[\\] = \\[([^\\]]*)\\]`));
        expect(m, `${name} not found in ${file}`).not.toBeNull();
        const items = [...m![1]!.matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]!);
        expect(items.length, `${name} in ${file} parsed to nothing`).toBeGreaterThan(0);
        return items;
      };
      const only = list('SINGBOX_NODE_PROTOCOLS');
      const capable = list('SINGBOX_ENGINE_CAPABLE');
      for (const p of [...only, ...capable]) expect(want).toContain(p);
      expect(only.filter((p) => capable.includes(p))).toEqual([]);
    },
  );

  it('agrees with the installer on the port a fresh node listens on', () => {
    const installer = readFileSync(INSTALLER, 'utf8');
    const m = installer.match(/^NODE_PORT=\$\{NODE_PORT:-(\d+)\}/m);
    expect(m, 'NODE_PORT default not found in install-iceslab-node.sh').not.toBeNull();
    const shellDefault = Number(m![1]);

    for (const file of ['components/NodeFormModal.tsx', 'pages/NodeEditPage.tsx', 'pages/NodeCreatePage.tsx'] as const) {
      const fm = read(file).match(/const DEFAULT_NODE_PORT = (\d+);/);
      expect(fm, `DEFAULT_NODE_PORT not found in ${file}`).not.toBeNull();
      expect(Number(fm![1]), `${file} disagrees with the installer`).toBe(shellDefault);
    }
  });
});
