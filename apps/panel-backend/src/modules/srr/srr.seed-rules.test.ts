// The User-Agent rules a FRESH deployment gets, read from the migrations that
// ship them.
//
// Not from the database on purpose. `cleanDatabase()` truncates the table, so a
// test that seeded its own rows would be checking its own fixture; and the lab
// databases have had the seed wiped, which is exactly the state in which nobody
// would notice the rules being wrong. What ships is the SQL, so that is what is
// read here and compiled with the real compiler.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileRule } from './srr.service.js';

const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');

/** The pattern a fresh deployment ends up with for a named rule: the seeded
 *  INSERT, with any later UPDATE of the same rule applied in migration order. */
function shippedPattern(ruleName: string): string {
  let pattern = '';
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    let sql: string;
    try {
      sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    } catch {
      continue;
    }
    const inserted = new RegExp(`'${ruleName}',\\s*'([^']*)'`).exec(sql);
    if (inserted) pattern = inserted[1] as string;
    // Every UPDATE in the file, in order — one migration may re-point several
    // rules, and taking only the first silently reports the others unchanged.
    const updates = sql.matchAll(
      /SET "ua_pattern" = '([^']*)'[\s\S]*?WHERE "name" = '([^']*)'/g,
    );
    for (const u of updates) if (u[2] === ruleName) pattern = u[1] as string;
  }
  return pattern;
}

describe('seeded User-Agent rules', () => {
  it('routes the Clash-family clients it names, whatever the casing', () => {
    const pattern = shippedPattern('Clash');
    expect(pattern, 'no seeded Clash rule found in the migrations').not.toBe('');
    const re = compileRule(pattern);

    // `stash` is in the pattern in lower case, which is only explicable as an
    // attempt to catch this client. Before 20260826000000 the rule was compiled
    // case-sensitively and could not.
    expect(re.test('Stash/2.9.0'), 'Stash falls through to the plain catch-all').toBe(true);
    // Clash Verge ships its name lower-cased in the UA.
    expect(re.test('clash-verge/2.0.3')).toBe(true);
    // And everything that already worked keeps working.
    for (const ua of ['FlClash/0.8.80', 'ClashX/1.118.0', 'mihomo/1.18', 'ClashMetaForAndroid/2.11'])
      expect(re.test(ua), ua).toBe(true);
    // Still narrow: an unrelated client must not be dragged into `clash`.
    expect(re.test('Happ/1.0')).toBe(false);
    expect(re.test('v2rayNG/1.8.0')).toBe(false);
  });

  it('gives every seeded rule the case-insensitive flag its neighbours have', () => {
    // The whole 20260617020000 batch carries `(?i)` and says why: a client that
    // misses its rule "fell through to the `.*` -> plain catch-all and got a
    // base64 list they can't import". A rule without it is that bug waiting.
    const named = ['Hiddify', 'NekoBox/NekoRay', 'sing-box', 'Clash', 'v2rayN'];
    const missing = named.filter((n) => !shippedPattern(n).startsWith('(?i)'));
    expect(missing).toEqual([]);
  });
});
