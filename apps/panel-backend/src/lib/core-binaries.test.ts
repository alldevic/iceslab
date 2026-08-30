import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORE_ARCHES,
  CORE_BINARIES,
  CORE_NAMES,
  PROTOCOL_CORE,
  coreAssetUrl,
  coreSourceUrl,
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

/**
 * A core the image COMPILES has no published binary and therefore no published
 * sum: its pin is the source tarball's, checked in the same `sha256sum -c` at
 * build time, and the panel states the sum of what it built (a `.sha256`
 * sidecar) to the node. Every rule below that is about a DOWNLOADED artefact
 * skips those, and `describe('a core built from source')` covers them instead -
 * an exemption without its own rules is how a whole core stops being checked.
 */
const isBuilt = (core: { source?: unknown }) => Boolean(core.source);

describe('the manifest is populated at all', () => {
  it('names cores', () => {
    // The control: every comparison below is over this list, and an empty one
    // would make all of them true.
    expect(CORE_NAMES.length).toBeGreaterThan(3);
    expect(CORE_NAMES).toContain('xray');
  });
});

describe.each(entries)('%s', (name, core) => {
  const assets = Object.entries(core.assets) as [
    CoreArch,
    { file: string; sha256: string | null },
  ][];
  const downloaded = isBuilt(core) ? [] : assets;

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
    if (isBuilt(core)) {
      // A published sum here would be a claim about bytes nobody published.
      expect(asset.sha256, `${name}/${arch} is built from source, so it pins no binary`).toBeNull();
      return;
    }
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
    for (const [arch] of downloaded) {
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
      if (core.assets[arch] && !isBuilt(core)) continue;
      expect(coreAssetUrl(name, arch)).toBeNull();
    }
  });
});

describe('across the whole manifest', () => {
  it('no checksum appears twice', () => {
    // A pasted sum is the likeliest hand-edit error and the one a build cannot
    // catch: two architectures claiming the same bytes both verify against the
    // same download, and half the fleet gets the wrong binary.
    const sums = entries
      .filter(([, core]) => !isBuilt(core))
      .flatMap(([name, core]) =>
        Object.entries(core.assets).map(([arch, a]) => ({
          key: `${name}/${arch}`,
          sha: a.sha256 as string,
        })),
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

/**
 * A core the image compiles trades one pin for another, so it needs its own
 * rules rather than an exemption from everyone else's. What a downloaded core
 * gets from `sha256sum -c` on the artefact, this one gets from the same check
 * on the SOURCE plus a toolchain that is stated in two places - the manifest
 * and the Dockerfile's `GO_IMAGE`, because a FROM cannot read a manifest.
 *
 * Two places is the whole reason for the last case here. sing-box 1.13.19 does
 * not compile under Go 1.27.0 (a dependency reaches into the standard library's
 * experimental encoding/json/v2), so the version is NOT the node's pin, and a
 * later bump that only touches one of the two would build a different binary or
 * fail with a message about a dependency rather than about a pin.
 */
describe('a core built from source', () => {
  const built = entries.filter(([, core]) => isBuilt(core));

  it('exists at all', () => {
    // The control: every case below is over this list.
    expect(built.map(([n]) => n)).toEqual(['sing-box']);
  });

  it.each(built)('%s pins its source by sha256 and https', (_name, core) => {
    const src = (core as { source: { urlTemplate: string; sha256: string; file: string } }).source;
    expect(src.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(src.urlTemplate.startsWith('https://')).toBe(true);
    expect(coreSourceUrl(_name)).toContain(core.version);
    expect(coreSourceUrl(_name)).not.toContain('{');
  });

  it.each(built)('%s unpacks to a directory named for the pinned version', (_name, core) => {
    const src = (core as { source: { unpacksTo: string } }).source;
    expect(src.unpacksTo).toContain(core.version);
  });

  it.each(built)('%s asks for the tag that is the reason it is built', (_name, core) => {
    const src = (core as { source: { extraTags: readonly string[]; tagsFile: string } }).source;
    // Without it the binary is the published one again, and sing-box refuses to
    // start on the config this panel writes.
    expect(src.extraTags).toContain('with_v2ray_api');
    // The base set is read from the tarball, never restated here.
    expect(src.tagsFile.startsWith('release/')).toBe(true);
  });

  it.each(built)('%s renames a stats service to something the agent can call', (_name, core) => {
    const r = (core as { source: { renameStatsService: { inFile: string; from: string; to: string } } })
      .source.renameStatsService;
    // `inFile`, not `file`: build-singbox.sh reads this manifest by line, and
    // `file` is already a key of the source block - it matched that one and
    // tried to patch the tarball instead of a Go file.
    expect(r.inFile).toMatch(/\.go$/);
    expect(r.from).not.toBe(r.to);
    // The rename exists so ONE client serves both cores. If the target ever
    // stops being the name xray answers to, the agent's statsquery goes back to
    // `Unimplemented` against a perfectly healthy API - which is where this
    // started, and which nothing else in this repo would notice.
    expect(r.to).toBe('xray.app.stats.command.StatsService');
    expect(r.from).toContain('StatsService');
  });

  it.each(built)('%s pins the SAME Go the image builds it with', (name, core) => {
    const src = (core as { source: { goVersion: string } }).source;
    const dockerfile = readFileSync(
      join(import.meta.dirname, '..', '..', 'Dockerfile'),
      'utf8',
    );
    const m = dockerfile.match(/^ARG GO_IMAGE=golang:([0-9]+\.[0-9]+\.[0-9]+)-/m);
    expect(m, 'no `ARG GO_IMAGE=golang:x.y.z-...` in the backend Dockerfile').not.toBeNull();
    expect(
      m![1],
      `the Dockerfile builds ${name} with Go ${m?.[1]} while the manifest pins ${src.goVersion}`,
    ).toBe(src.goVersion);
  });

  it.each(built)('%s is served under a name that carries the pinned version', (_name, core) => {
    for (const [arch, a] of Object.entries(core.assets)) {
      expect(a.file, `${arch}`).toContain(core.version);
      expect(a.file, `${arch}`).toContain(arch);
    }
  });
});
