import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The cap on `GET /api/users`, against the page size the shop asks with.
 *
 * The route's own comment states the rule and the cost: the shop's offset loop
 * terminates on `len(batch) < page_size`, so a cap smaller than that page size
 * returns a short first page, the loop stops early, and the shop treats every
 * user past the cap as absent — deactivating their PAID subscriptions. It is
 * the fallback path (the primary is the cursor-driven stream), which means it
 * fires exactly when something else has already gone wrong.
 *
 * Two artefacts in two repositories, held together by a comment. The shop is an
 * external checkout, so when it is not on this machine the cross-repo half
 * cannot run — and this file says so out loud rather than passing quietly. The
 * side that IS always here is checked either way.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = resolve(HERE, 'remnawave.routes.ts');
const SHOP = process.env.MINISHOP_DIR ?? '/home/stdfo/workspace/minishop-361';
const SHOP_SETTINGS = resolve(SHOP, 'backend/config/settings.py');

/** The upper bound the route clamps `size` to. */
function facadeCap(): number {
  const src = readFileSync(ROUTES, 'utf8');
  const at = src.indexOf("app.get('/api/users'");
  expect(at, "the /api/users route was renamed or moved").toBeGreaterThan(-1);
  const body = src.slice(at, at + 1200);
  const m = body.match(/Math\.min\(Math\.max\(parseInt\(q\.size[^)]*\)[^,]*,\s*\d+\s*\),\s*(\d+)\s*\)/);
  expect(m, 'the size clamp is no longer a Math.min/Math.max pair; re-read the route').not.toBeNull();
  return Number(m![1]);
}

describe('the /api/users page cap', () => {
  it('is at least the page size its own comment names', () => {
    // The comment is the only statement of the rule that ships with the code,
    // so it is read rather than restated: if someone lowers the cap and edits
    // the comment to match, that is a decision, not a drift.
    const src = readFileSync(ROUTES, 'utf8');
    const m = src.match(/PANEL_ALL_USERS_PAGE_SIZE,\s*default\s+(\d+)/);
    expect(m, 'the route no longer names the shop setting it must match').not.toBeNull();
    expect(facadeCap()).toBeGreaterThanOrEqual(Number(m![1]));
  });

  // Not a skip, and not a silent pass: an assertion that holds prints nothing,
  // and this run's console output is swallowed by the reporter, so the one
  // place a reader will always see it is the case's own name.
  const shopPresent = existsSync(SHOP_SETTINGS);
  it(
    shopPresent
      ? 'is at least the page size the shop actually asks with'
      : `CROSS-REPO HALF NOT RUN: no minishop checkout at ${SHOP} (set MINISHOP_DIR); ` +
        'only the comment side of the cap was compared',
    () => {
      if (!shopPresent) {
        // The half that IS here still has to be true, so the case is not empty.
        expect(facadeCap()).toBeGreaterThan(0);
        return;
      }
      const settings = readFileSync(SHOP_SETTINGS, 'utf8');
      const m = settings.match(/PANEL_ALL_USERS_PAGE_SIZE:\s*int\s*=\s*Field\(default=(\d+)\)/);
      expect(m, 'PANEL_ALL_USERS_PAGE_SIZE is no longer a Field(default=...) in the shop settings').not.toBeNull();
      expect(
        facadeCap(),
        'the shop would stop paging early and deactivate the subscriptions of everyone past our cap',
      ).toBeGreaterThanOrEqual(Number(m![1]));
    },
  );
});
