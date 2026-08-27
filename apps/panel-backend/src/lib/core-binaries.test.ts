import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORE_ARCHES,
  CORE_BINARIES,
  CORE_NAMES,
  PROTOCOL_CORE,
  coreAssetUrl,
  type CoreArch,
  type CoreName,
} from '@iceslab/shared';

/**
 * The pinned core manifest, checked for the ways a hand-edited pin goes wrong.
 *
 * Nothing here can tell whether a sha256 is the RIGHT one — only the download
 * can, and it does: the panel image fetches every artefact at build time and
 * `sha256sum -c` fails the build on a mismatch, with `image-selftest.sh` then
 * asking the built image whether what it carries still matches this file. What
 * these cases catch is the other half, the half a build cannot: a bump that
 * moved the version and left a checksum, a checksum pasted twice, an
 * architecture declared with half an asset.
 */

const entries = Object.entries(CORE_BINARIES) as [CoreName, (typeof CORE_BINARIES)[CoreName]][];

describe('the manifest is populated at all', () => {
  it('names cores', () => {
    // The control: every comparison below is over this list, and an empty one
    // would make all of them true.
    expect(CORE_NAMES.length).toBeGreaterThan(3);
    expect(CORE_NAMES).toContain('xray');
  });
});

describe.each(entries)('%s', (name, core) => {
  const assets = Object.entries(core.assets) as [CoreArch, { file: string; sha256: string }][];

  it('is published for at least amd64', () => {
    // Every VPS fleet has amd64 in it. A core with no amd64 asset is a core no
    // operator can install, and the refusal would come at install time on a
    // node rather than here.
    expect(Object.keys(core.assets)).toContain('amd64');
  });

  it('declares only architectures the node knows how to name', () => {
    expect(assets.map(([arch]) => arch).filter((a) => !CORE_ARCHES.includes(a))).toEqual([]);
  });

  it.each(assets)('%s carries a whole asset', (arch, asset) => {
    expect(asset.file.length).toBeGreaterThan(3);
    expect(asset.sha256, `${name}/${arch} sha256 is not 64 lowercase hex`).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('names the pinned version in every file name that carries one', () => {
    // The failure this is for: bumping `version` and leaving a file name behind.
    // Some projects put the version in the artefact name (sing-box, mtg,
    // mieru) and some do not (xray, hysteria); the rule is only about the ones
    // that do, and it reads the file name rather than a list of which is which.
    const versioned = assets.filter(([, a]) => /\d+\.\d+\.\d+/.test(a.file));
    for (const [arch, a] of versioned) {
      expect(a.file, `${name}/${arch} names a version other than ${core.version}`).toContain(
        core.version,
      );
    }
  });

  it('builds an https url with both placeholders filled', () => {
    for (const [arch] of assets) {
      const url = coreAssetUrl(name, arch)!;
      expect(url.startsWith('https://'), `${name}/${arch} is not https`).toBe(true);
      expect(url).not.toContain('{');
      expect(url).toContain(core.version);
    }
  });

  it('answers null for an architecture it does not carry', () => {
    // The other direction, and the one the node installer depends on: an
    // absent architecture has to be absent, not an url that 404s. Both real
    // absences here were found exactly that way.
    for (const arch of CORE_ARCHES) {
      if (core.assets[arch]) continue;
      expect(coreAssetUrl(name, arch)).toBeNull();
    }
  });
});

describe('across the whole manifest', () => {
  it('no checksum appears twice', () => {
    // A pasted sum is the likeliest hand-edit error and the one a build cannot
    // catch: two architectures claiming the same bytes both verify against the
    // same download, and half the fleet gets the wrong binary.
    const sums = entries.flatMap(([name, core]) =>
      Object.entries(core.assets).map(([arch, a]) => ({ key: `${name}/${arch}`, sha: a.sha256 })),
    );
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const { key, sha } of sums) {
      const first = seen.get(sha);
      if (first) dupes.push(`${key} repeats the sha256 of ${first}`);
      else seen.set(sha, key);
    }
    expect(dupes).toEqual([]);
    expect(sums.length).toBeGreaterThan(8);
  });

  it('no file name appears twice, because the panel serves them by name', () => {
    const files = entries.flatMap(([name, core]) =>
      Object.entries(core.assets).map(([arch, a]) => `${name}-${arch}:${a.file}`),
    );
    expect(new Set(files).size).toBe(files.length);
  });
});

describe('the protocol → core map', () => {
  it('names a core this manifest pins, or names nothing', () => {
    const bad = Object.entries(PROTOCOL_CORE)
      .filter(([, core]) => core !== null && !(core in CORE_BINARIES))
      .map(([proto, core]) => `${proto} -> ${core}`);
    expect(bad, 'a protocol pointed at a core the manifest does not carry').toEqual([]);
  });

  it('is the same map the node installer fetches by', () => {
    // The installer's `case "$PROTOCOL"` is where this decision is executed;
    // this file is where it is READ. Two copies would drift, and the panel's is
    // the one an operator reads, so the shell is checked against it: every core
    // name the installer asks the panel for has to be one the manifest pins,
    // and a typo there would 404 on every install of that protocol.
    const installer = readFileSync(
      join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'install-iceslab-node.sh'),
      'utf8',
    );
    const asked = [...installer.matchAll(/panel_core_fetch\s+([a-z-]+)\s/g)].map((m) => m[1]!);
    // The control: a scan that found nothing would make the comparison below
    // true of any installer at all.
    expect(new Set(asked).size, 'no panel_core_fetch call sites found').toBeGreaterThan(2);
    expect(
      [...new Set(asked)].filter((c) => !(c in CORE_BINARIES)).sort(),
      'the installer asks the panel for a core the manifest does not pin',
    ).toEqual([]);
  });
});
