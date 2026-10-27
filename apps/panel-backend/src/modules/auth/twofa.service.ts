import { prisma } from '../../prisma.js';
import { redis } from '../../lib/infra/redis.js';
import { config } from '../../config.js';
import { generateSecret, totpUri, verifyTotpStep } from '../../lib/auth/totp.js';
import { AccountLockedError } from './auth.service.js';

// K8 - admin 2FA (TOTP) enrollment lifecycle. setup writes a pending secret;
// enable flips it on only after a valid code is confirmed (so a broken/
// mis-scanned secret can never lock the admin out); disable requires a current
// code so a stolen session can't silently turn 2FA off.

const ISSUER = 'Iceslab';

export class TotpNotSetupError extends Error {
  constructor() {
    super('2FA is not set up');
    this.name = 'TotpNotSetupError';
  }
}
export class TotpAlreadyEnabledError extends Error {
  constructor() {
    super('2FA is already enabled');
    this.name = 'TotpAlreadyEnabledError';
  }
}
export class TotpBadCodeError extends Error {
  constructor() {
    super('Invalid 2FA code');
    this.name = 'TotpBadCodeError';
  }
}

export async function getTotpStatus(adminId: string): Promise<{ enabled: boolean }> {
  const admin = await prisma.adminUser.findFirst({
    where: { id: adminId, deletedAt: null },
    select: { totpEnabled: true },
  });
  return { enabled: admin?.totpEnabled ?? false };
}

/** Generate a fresh secret (pending, not yet enforced) and return it + the
 *  otpauth URI for QR enrollment. Re-running before enable rotates the secret. */
export async function setupTotp(adminId: string): Promise<{ secret: string; uri: string }> {
  const admin = await prisma.adminUser.findFirst({ where: { id: adminId, deletedAt: null } });
  if (!admin) throw new TotpNotSetupError();
  if (admin.totpEnabled) throw new TotpAlreadyEnabledError();
  const secret = generateSecret();
  await prisma.adminUser.update({
    where: { id: adminId },
    data: { totpSecret: secret, totpEnabled: false },
  });
  return { secret, uri: totpUri(secret, admin.username, ISSUER) };
}

/*
 * A-123, second half (22.10): enable and disable checked a code with no
 * failure count and no replay guard, while the login has both. Disable is the
 * one that matters: it exists so a hijacked session cannot turn 2FA off, and
 * against it a session could try codes at the general 100 a minute, three
 * valid codes in every million with the ±1 step window. Now both count
 * failures per admin and lock with the login's numbers
 * (LOGIN_LOCKOUT_FAILURES, _WINDOW_MIN, _DURATION_MIN), and a code's time step
 * is spent once: the step must be past the last one accepted, the rule the
 * login applies (RFC 6238 section 5.2), and the step accepted here is recorded,
 * so the code that turned 2FA on cannot sign in a second time.
 */
const FAIL_KEY = (adminId: string): string => `auth:2fa-fail:${adminId}`;

async function checkLocked(adminId: string): Promise<void> {
  const key = FAIL_KEY(adminId);
  const current = await redis.get(key);
  if (current === null) return;
  const count = Number.parseInt(current, 10);
  if (Number.isFinite(count) && count >= config.LOGIN_LOCKOUT_FAILURES) {
    const ttl = await redis.ttl(key);
    throw new AccountLockedError(ttl > 0 ? ttl : 60);
  }
}

async function recordFailure(adminId: string): Promise<void> {
  const key = FAIL_KEY(adminId);
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, config.LOGIN_LOCKOUT_WINDOW_MIN * 60);
  if (n >= config.LOGIN_LOCKOUT_FAILURES) await redis.expire(key, config.LOGIN_LOCKOUT_DURATION_MIN * 60);
}

/** The accepted step of a code, or a counted failure. */
async function spendCode(
  admin: { id: string; totpSecret: string; totpLastUsedStep: number | null },
  code: string,
): Promise<number> {
  await checkLocked(admin.id);
  const step = verifyTotpStep(admin.totpSecret, code);
  if (step === null || (admin.totpLastUsedStep !== null && step <= admin.totpLastUsedStep)) {
    await recordFailure(admin.id);
    throw new TotpBadCodeError();
  }
  await redis.del(FAIL_KEY(admin.id));
  return step;
}

/** Confirm a code against the pending secret and turn enforcement on. */
export async function enableTotp(adminId: string, code: string): Promise<void> {
  const admin = await prisma.adminUser.findFirst({ where: { id: adminId, deletedAt: null } });
  if (!admin?.totpSecret) throw new TotpNotSetupError();
  if (admin.totpEnabled) throw new TotpAlreadyEnabledError();
  const step = await spendCode({ ...admin, totpSecret: admin.totpSecret }, code);
  await prisma.adminUser.update({ where: { id: adminId }, data: { totpEnabled: true, totpLastUsedStep: step } });
}

/** Turn 2FA off. Requires a current valid code so a hijacked session can't. */
export async function disableTotp(adminId: string, code: string): Promise<void> {
  const admin = await prisma.adminUser.findFirst({ where: { id: adminId, deletedAt: null } });
  if (!admin?.totpEnabled || !admin.totpSecret) throw new TotpNotSetupError();
  const step = await spendCode({ ...admin, totpSecret: admin.totpSecret }, code);
  await prisma.adminUser.update({
    where: { id: adminId },
    data: { totpSecret: null, totpEnabled: false, totpLastUsedStep: step },
  });
}
