import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORE_COMPONENTS,
  CORE_ENV_PREFIX as PIN_PREFIX,
  CORE_SCRIPTS,
  CORE_VERSIONS,
  ENGINE_BOOTSTRAP,
  coreAssetUrl,
  coreEnvPair,
  coreScriptUrl,
  type CoreComponent,
} from '@iceslab/shared';
import {
  PIN_SITES,
  blockEnd,
  blockStart,
  readPinBlock,
  renderPinBlock,
  writePinBlock,
} from './core-pins.js';

/**
 * The installers' pins against the version manifest.
 *
 * Before the manifest every script held its own number and a Go test held a
 * second copy of each (xray's twice), so moving a pin meant finding every copy
 * by hand. Now the scripts carry a block generated from the manifest, and this
 * is the test that says when a block and the manifest disagree.
 *
 * To move a pin: edit packages/shared/src/core-versions.ts, then run
 *   UPDATE_CORE_PINS=1 node ./node_modules/vitest/vitest.mjs run src/lib/util/core-pins.test.ts
 * and commit the manifest and the rewritten scripts together.
 *
 * ⚠ The update mode writes into the scripts. Run it on purpose, never in CI.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const UPDATE = process.env.UPDATE_CORE_PINS === '1';

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

if (UPDATE) {
  for (const site of PIN_SITES) {
    let text = read(site.file);
    for (const c of site.components) text = writePinBlock(text, c);
    writeFileSync(join(ROOT, site.file), text);
  }
}

describe('every installer carries the manifest, byte for byte', () => {
  const cases = PIN_SITES.flatMap((s) => s.components.map((c) => [s.file, c] as const));

  it.each(cases)('%s: %s', (file, component) => {
    const text = read(file);
    expect(text.split(blockStart(component)).length - 1, 'exactly one block').toBe(1);
    expect(text.split(blockEnd(component)).length - 1, 'exactly one block').toBe(1);
    expect(readPinBlock(text, component)).toBe(renderPinBlock(component));
  });

  it('every pinned component reaches at least one installer', () => {
    const reached = new Set(PIN_SITES.flatMap((s) => s.components));
    const pinned = CORE_COMPONENTS.filter((c) => CORE_VERSIONS[c].pinned !== null);
    expect(pinned.filter((c) => !reached.has(c))).toEqual([]);
  });

  it('a release kept outside its upstream is fetched from the repository the pin names', () => {
    // A-212: sing-box is our build in our repository. A script that keeps the
    // upstream address asks for a tag and a file that exist only with us.
    for (const site of PIN_SITES) {
      for (const c of site.components) {
        const entry = CORE_VERSIONS[c];
        const release = entry.releases.find((r) => r.version === entry.pinned);
        if (!release?.repo) continue;
        expect(read(site.file), `${c}: ${site.file}`).toContain(`https://github.com/\${${PIN_PREFIX[c]}_PINNED_REPO}/releases/download/`);
      }
    }
  });

  it('the main installer carries no pin block: every core goes on through its bootstrap', () => {
    // A block here would be a second pin for a core its bootstrap already pins,
    // which is the copy --engines removed (hysteria had one until then).
    expect(read('scripts/install-iceslab-node.sh')).not.toContain('# >>> core-pins:');
  });
});

describe('no hand-written copy of a pin is left beside its block', () => {
  // The copies are what this replaces: a default like XRAY_VERSION=v26.3.27
  // outside the block would still win, and nothing would say it went stale.
  const outsideBlocks = (text: string, components: CoreComponent[]) => {
    let rest = text;
    for (const c of components) {
      const block = readPinBlock(rest, c);
      if (block) rest = rest.replace(block, '');
    }
    return rest;
  };

  it.each(PIN_SITES.map((s) => [s.file, s.components] as const))('%s', (file, components) => {
    const rest = outsideBlocks(read(file), components);
    for (const c of components) {
      const { version } = CORE_VERSIONS[c].releases.find((r) => r.version === CORE_VERSIONS[c].pinned)!;
      const escaped = version.replace(/\./g, '\\.');
      const assignment = new RegExp(`^\\s*[A-Z_]+=.*\\bv?${escaped}\\b`, 'm');
      expect(rest, `${c}: an assignment outside the block names ${version}`).not.toMatch(assignment);
      expect(rest, `${c}: the pinned version is assigned outside the block`).not.toMatch(
        new RegExp(`^\\s*${PIN_PREFIX[c]}_PINNED_`, 'm'),
      );
    }
  });
});

describe('the payload road names the same variables as the scripts', () => {
  // The panel's choice reaches a script as <P>_VERSION/<P>_SHA256 (or
  // <P>_TAG/<P>_SHA for a commit-built core): the agent's `core-env` writes the
  // pair, the installer accepts it, the script reads it. Three places, one
  // table; a prefix spelt differently in one of them is a choice that silently
  // never arrives.
  const pinned = CORE_COMPONENTS.filter((c) => CORE_VERSIONS[c].pinned !== null);

  it('the agent maps every pinned component to the prefix its script reads', () => {
    const go = read('apps/node/internal/payload/coreenv.go');
    const block = /var componentEnv = map\[string\]string\{([\s\S]*?)\n\}/.exec(go);
    expect(block, 'componentEnv not found in coreenv.go').not.toBeNull();
    const table = Object.fromEntries(
      [...block![1]!.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
    expect(table).toEqual(Object.fromEntries(pinned.map((c) => [c, PIN_PREFIX[c]])));
  });

  it('the installer accepts exactly those pairs from the agent', () => {
    const installer = read('scripts/install-iceslab-node.sh');
    for (const c of pinned) {
      const [a, b] = coreEnvPair(c)!;
      expect(installer, `${c}: ${a}`).toMatch(new RegExp(`\\b${a}\\|`));
      expect(installer, `${c}: ${b}`).toMatch(new RegExp(`\\b${b}[|)]`));
    }
  });
});

describe('CI asks the engine the fleet runs, checked by the same sha256', () => {
  // The config-validity tests download xray, sing-box and hysteria, and the
  // mieru adapter's live test mita (A-275). A CI on another release answers for
  // an engine no node runs: green in CI, refused on the fleet.
  const ci = read('.github/workflows/ci.yml');

  it.each(['xray', 'singbox', 'hysteria', 'mita'] as const)('%s', (c) => {
    const entry = CORE_VERSIONS[c];
    const release = entry.releases.find((r) => r.version === entry.pinned)!;
    const asset = release.assets!.amd64!;
    const tag = release.tag.replace('/', '%2F');
    expect(ci).toContain(`releases/download/${tag}/${asset.file}`);
    expect(ci).toContain(`${asset.sha256}  `);
  });
});

describe('the download address the manifest derives is the one the scripts fetch from', () => {
  // The panel image downloads from coreAssetUrl(); a node's bootstrap used to
  // download from its own spelling of the same address. When the two differ, the
  // image carries a file nobody installs, or a repository that is not the one
  // the node would have used.
  const UPSTREAM_URL = /"(https:\/\/github\.com\/[^"]+\/releases\/download\/[^"]+)"/;

  it.each(['xray', 'singbox', 'hysteria', 'mtg', 'mita'] as const)('%s', (c) => {
    const entry = CORE_VERSIONS[c];
    const release = entry.releases.find((r) => r.version === entry.pinned)!;
    const script = read(`apps/node/scripts/${ENGINE_BOOTSTRAP[entry.reportedBy.engine]}`);
    const line = UPSTREAM_URL.exec(script);
    expect(line, `${c}: no release URL in the script`).not.toBeNull();
    // The script's spelling with its variables put back: the repository (a
    // literal, or the pin block's own repo variable), the tag (hysteria's slash
    // is written %2F) and the file.
    const repo = release.repo ? `\${${PIN_PREFIX[c]}_PINNED_REPO}` : entry.upstream;
    expect(line![1]!.startsWith(`https://github.com/${repo}/releases/download/`), line![1]).toBe(true);
    if (release.repo) {
      expect(readPinBlock(script, c)).toContain(`${PIN_PREFIX[c]}_PINNED_REPO="${release.repo}"`);
    }
    const tagEncoded = release.tag.includes('/');
    expect(line![1]!.includes('%2F'), `${c}: the script encodes the tag's slash`).toBe(tagEncoded);
    const url = coreAssetUrl(c, release, 'amd64')!;
    expect(url).toBe(
      `https://github.com/${release.repo ?? entry.upstream}/releases/download/${encodeURIComponent(release.tag)}/${release.assets!.amd64!.file}`,
    );
  });

  it('every component with an upstream repo names it in its own bootstrap', () => {
    // Not sing-box: its releases are ours, the script reads the repo from its block.
    for (const c of CORE_COMPONENTS) {
      if (c === 'singbox') continue;
      const entry = CORE_VERSIONS[c];
      const script = read(`apps/node/scripts/${ENGINE_BOOTSTRAP[entry.reportedBy.engine]}`);
      expect(script, `${c}: ${entry.upstream}`).toContain(`github.com/${entry.upstream}`);
    }
  });

  it('xray-install: repo, commit and sha256 are the bootstrap\'s', () => {
    const script = read('apps/node/scripts/bootstrap-xray.sh');
    const s = CORE_SCRIPTS['xray-install'];
    expect(script).toContain(`XRAY_INSTALLER_PINNED_REF="${s.ref}"`);
    expect(script).toContain(`XRAY_INSTALLER_PINNED_SHA="${s.sha256}"`);
    expect(script).toContain(`https://raw.githubusercontent.com/${s.repo}/\${XRAY_INSTALLER_REF}/${s.file}`);
    expect(coreScriptUrl(s)).toBe(`https://raw.githubusercontent.com/${s.repo}/${s.ref}/${s.file}`);
  });
});
