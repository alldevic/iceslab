import { describe, expect, it, beforeEach, afterAll } from 'vitest';

import { prisma } from '../../prisma.js';
import { invalidateSrrCache, matchFormatForUserAgent } from './srr.service.js';

/**
 * A rule stored before the save-time guard existed, on the path that guard was
 * written to protect.
 *
 * Two comments used to point at each other. `srr.service.ts` said the real
 * ReDoS defence is "refusing catastrophic patterns at save time
 * (srr.schemas.ts)"; `srr.schemas.ts` said "Existing pre-fix rules are not
 * re-validated". Between those two sentences sat every row older than the
 * check — compiled into the cache and run against every `/sub` poll, which is
 * the one path where a backtracking pattern is a denial of service rather than
 * a slow page.
 *
 * Measured 2026-08-28 with the runtime skip removed: ONE such rule against a
 * thirty-character User-Agent took 61.6 seconds inside a single request. With
 * it, the rule is skipped and the answer is immediate.
 */
describe('a rule whose pattern predates the save-time guard', () => {
  beforeEach(async () => {
    await prisma.subscriptionResponseRule.deleteMany({});
    invalidateSrrCache();
  });

  afterAll(async () => {
    await prisma.subscriptionResponseRule.deleteMany({});
    invalidateSrrCache();
  });

  it(
    'is skipped rather than run against the User-Agent',
    async () => {
      // Written straight to the table, the way a row older than the check is
      // already there. The API refuses this pattern today.
      await prisma.subscriptionResponseRule.create({
        data: { name: 'legacy', uaPattern: '(a+)+$', format: 'clash', priority: 1, enabled: true },
      });

      const started = Date.now();
      const got = await matchFormatForUserAgent(`${'a'.repeat(27)}!`);
      const took = Date.now() - started;

      expect(got, 'a pattern the API would refuse decided a subscription format').toBeNull();
      // Generous on purpose: the point is seconds versus milliseconds, and the
      // machine running this is not always idle. Without the skip, 27 a's cost
      // about eight seconds; the thirty in the measurement above cost sixty.
      expect(took, 'the request spent its time backtracking').toBeLessThan(2_000);
    },
    20_000,
  );

  it('while a rule with a safe pattern still decides the format', async () => {
    // The control. "Nothing matched" is also true of a matcher that stopped
    // matching anything at all.
    await prisma.subscriptionResponseRule.create({
      data: { name: 'ok', uaPattern: '(?i)happ', format: 'singbox', priority: 1, enabled: true },
    });
    expect(await matchFormatForUserAgent('Happ/1.2 (iOS)')).toBe('singbox');
  });
});
