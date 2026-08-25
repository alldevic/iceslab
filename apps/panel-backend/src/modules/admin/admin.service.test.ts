// The two rules that stand between a stranger and the admin panel, neither of
// which anything checked.
//
// Measured before writing: the whole suite (1513 tests) stayed green with the
// bootstrap advisory lock deleted, with `recordTotpStep` writing nothing, and
// with the replay comparison removed from the login path. Every registerAdmin
// helper in the suite is sequential, so the lock is invisible to all of them,
// and no test in the repository ever enabled 2FA.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateTotp } from '../../lib/totp.js';
import * as authService from '../auth/auth.service.js';
import * as adminService from './admin.service.js';

const PASSWORD = 'password123';

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('bootstrap creates exactly one first admin', () => {
  // /api/auth/register is the only unauthenticated write in the panel: it is
  // open precisely while there is nobody to authenticate as. Requests that
  // arrive together would otherwise all read count===0 and all succeed, and
  // everyone after the first is a stranger with full access. A Postgres
  // advisory lock inside the transaction serialises them so the re-check
  // happens under it.
  //
  // The size of the burst is a measurement, not a flourish. With the lock
  // deleted, TWO concurrent calls still produced exactly one admin on every
  // attempt - the transactions simply did not overlap - so a two-way test
  // would have passed against the defect it names. Eight caught it on 4 runs
  // out of 4. Do not shrink this number without repeating that measurement.
  it('lets exactly one of eight simultaneous registrations through', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        adminService.bootstrapFirstAdmin({ username: `race-${i}`, password: PASSWORD }),
      ),
    );

    const created = results.filter((r) => r.status === 'fulfilled');
    expect(created, 'only one concurrent bootstrap may create an admin').toHaveLength(1);

    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect(
        (r as PromiseRejectedResult).reason,
        'the losers must be told registration is closed, not fail on something incidental',
      ).toBeInstanceOf(adminService.RegistrationDisabledError);
    }

    // The count in the database is the invariant; the promise results are only
    // how we noticed.
    expect(await adminService.countAdmins()).toBe(1);
  });
});

describe('a TOTP code cannot be used twice', () => {
  async function adminWith2fa(): Promise<{ username: string; secret: string }> {
    const username = 'admin';
    await adminService.bootstrapFirstAdmin({ username, password: PASSWORD });
    // JBSWY3DPEHPK3PXP is the RFC-style sample secret; any valid base32 does.
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    await prisma.adminUser.updateMany({
      where: { username },
      data: { totpSecret: secret, totpEnabled: true },
    });
    return { username, secret };
  }

  // The attack this defends against is a code observed in flight - over the
  // admin's shoulder, from a phished form, out of a proxy log - and replayed
  // inside the 30-second window it is still valid for. Rejecting the reuse is
  // the entire point of storing the step; without it 2FA degrades to "a second
  // password that changes every half minute".
  it('accepts a code once and refuses the same code straight after', async () => {
    const { username, secret } = await adminWith2fa();
    const code = generateTotp(secret, Math.floor(Date.now() / 1000));

    const admin = await authService.login({ username, password: PASSWORD, totpCode: code }, '10.0.0.1');
    expect(admin.username).toBe(username);

    await expect(
      authService.login({ username, password: PASSWORD, totpCode: code }, '10.0.0.1'),
      'the same code, still inside its validity window, must not open a second session',
    ).rejects.toBeInstanceOf(authService.InvalidTotpError);
  });

  // The refusal has to come from the replay guard, not from a lockout the
  // first failure happened to trigger: otherwise this test would pass on a
  // panel with no replay guard at all.
  it('still accepts the NEXT code after a replay was refused', async () => {
    const { username, secret } = await adminWith2fa();
    const nowSec = Math.floor(Date.now() / 1000);
    const code = generateTotp(secret, nowSec);

    await authService.login({ username, password: PASSWORD, totpCode: code }, '10.0.0.2');
    await expect(
      authService.login({ username, password: PASSWORD, totpCode: code }, '10.0.0.2'),
    ).rejects.toBeInstanceOf(authService.InvalidTotpError);

    // A code from the NEXT step is what the admin's authenticator shows a
    // moment later, and it must work. Anchored to the step that was actually
    // stored rather than to a clock read here: verification uses a +/-1 window
    // around real now, so a code two steps out would be refused for being out
    // of window and this test would prove the wrong thing.
    const { totpLastUsedStep } = await prisma.adminUser.findFirstOrThrow({ where: { username } });
    const next = generateTotp(secret, (totpLastUsedStep! + 1) * 30);
    const admin = await authService.login(
      { username, password: PASSWORD, totpCode: next },
      '10.0.0.2',
    );
    expect(admin.username, 'a fresh code after a refused replay must still log in').toBe(username);
  });

  // recordTotpStep is what makes the refusal possible, and it is a plain write
  // nothing else observes. Checked against the step the code actually belongs
  // to, so a write of the wrong number is not mistaken for a write.
  it('stores the step the accepted code belongs to', async () => {
    const { username, secret } = await adminWith2fa();
    const nowSec = Math.floor(Date.now() / 1000);
    const code = generateTotp(secret, nowSec);

    await authService.login({ username, password: PASSWORD, totpCode: code }, '10.0.0.3');

    const admin = await prisma.adminUser.findFirstOrThrow({ where: { username } });
    expect(
      admin.totpLastUsedStep,
      'without the stored step the next login has nothing to compare against',
    ).toBe(Math.floor(nowSec / 30));
  });

  // An older code is a captured code too: the window is +/-1 step, so the one
  // from thirty seconds ago still verifies. It must not be accepted after a
  // newer one already was.
  it('refuses a code older than the one already accepted', async () => {
    const { username, secret } = await adminWith2fa();
    const nowSec = Math.floor(Date.now() / 1000);

    await authService.login(
      { username, password: PASSWORD, totpCode: generateTotp(secret, nowSec) },
      '10.0.0.4',
    );
    await expect(
      authService.login(
        { username, password: PASSWORD, totpCode: generateTotp(secret, nowSec - 30) },
        '10.0.0.4',
      ),
    ).rejects.toBeInstanceOf(authService.InvalidTotpError);
  });

  // An admin without 2FA must not be asked for a code, and must not be blocked
  // by the replay bookkeeping that only exists for 2FA logins.
  it('leaves an admin without 2FA alone', async () => {
    await adminService.bootstrapFirstAdmin({ username: 'plain', password: PASSWORD });
    const first = await authService.login({ username: 'plain', password: PASSWORD }, '10.0.0.5');
    const second = await authService.login({ username: 'plain', password: PASSWORD }, '10.0.0.5');
    expect(first.id).toBe(second.id);
  });
});
