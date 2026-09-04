import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRESET_GEOSITE, PRESET_GEOIP } from './geo.orchestrator.js';

/**
 * The subscription formats reference geo categories BY NAME; the geo build
 * decides which names the artifact this panel serves actually contains. Two
 * independent places, and until 2026-09-04 nothing made them agree.
 *
 * They had already disagreed where a buyer could see it. Every xray document
 * asked for `geosite:category-ads-all`; the emitted `geo-custom.dat` carried
 * only the operator's own categories. A client holding that artifact as its
 * geosite.dat does not lose ad-blocking - xray refuses to start, `code not
 * found in geosite.dat: CATEGORY-ADS-ALL`, and the channel is dead. Two buyers
 * reported it, and the error names that category only because it is the FIRST
 * geosite lookup in the rule list.
 *
 * So: a category a format asks for must be one the build is going to emit.
 *
 * There are NO exceptions, and this file used to carry one. `geoip:private`
 * reads like a built-in - xray's own RFC1918 list - so the first version of
 * this test excused it. It is not built in: the core looks it up in geoip.dat
 * like any other code, and an artifact without it fails to load with `code not
 * found in geoip.dat: PRIVATE`. The excuse was an assumption written as a
 * comment, and a stand caught it two hours later. An exemption in a mirror test
 * is a claim about the world, and it has to be measured like any other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORMATS = join(HERE, '..', 'subscription', 'formats');

function referenced(): { site: Set<string>; ip: Set<string>; files: string[] } {
  const site = new Set<string>();
  const ip = new Set<string>();
  const files: string[] = [];
  for (const f of readdirSync(FORMATS)) {
    if (!f.endsWith('.ts') || f.includes('.test.')) continue;
    const src = readFileSync(join(FORMATS, f), 'utf8');
    let hit = false;
    for (const m of src.matchAll(/geosite:([a-z0-9][a-z0-9-]*)/g)) {
      site.add(m[1]!);
      hit = true;
    }
    for (const m of src.matchAll(/geoip:([a-z0-9][a-z0-9-]*)/g)) {
      ip.add(m[1]!);
      hit = true;
    }
    if (hit) files.push(f);
  }
  return { site, ip, files };
}

describe('every geo category a format asks for is one the build emits', () => {
  it('finds the references at all', () => {
    // A mirror test that quietly matches nothing is worse than no test: it
    // reads green while checking an empty set. Three formats carry these
    // references today (xrayjson, clash, singbox); the floor is deliberately
    // below that so a rename does not fail this for the wrong reason.
    const { site, ip, files } = referenced();
    expect(files.length, 'no format file references a geo category').toBeGreaterThanOrEqual(2);
    expect(site.size).toBeGreaterThanOrEqual(2);
    expect(ip.size).toBeGreaterThanOrEqual(1);
  });

  it('names no geosite category the artifact will not carry', () => {
    const { site } = referenced();
    const missing = [...site].filter((c) => !PRESET_GEOSITE.includes(c));
    expect(
      missing,
      `formats ask for ${missing.join(', ')}, which no build emits - add it to ` +
        'PRESET_GEOSITE or stop referencing it. A client holding only our ' +
        'artifact cannot start xray at all when this is wrong.',
    ).toEqual([]);
  });

  it('names no geoip category the artifact will not carry', () => {
    const { ip } = referenced();
    const missing = [...ip].filter((c) => !PRESET_GEOIP.includes(c));
    expect(missing, `formats ask for geoip ${missing.join(', ')}, which no build emits`).toEqual([]);
  });
});
