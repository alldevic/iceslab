import * as usersService from '../users/users.service.js';
import type { PublicUserDto } from '../users/users.mapper.js';
import { RemnaError } from './remnawave.http.js';

/**
 * User identity on the Remnawave 3.x wire.
 *
 * 3.0 removed `uuid` from the user object and made the integer `id` the only
 * identifier its user-scoped routes accept. The facade therefore speaks the
 * NUMERIC handle (`User.numericId`) outward and never the UUID primary key — a
 * split kept in this one module so no route has to remember which of the two it
 * is holding.
 *
 * The client is strict about this in BOTH directions: once it has detected a 3.x
 * panel it refuses locally to send a non-decimal reference, so a single UUID
 * leaking into a response would take that user out of reach entirely rather than
 * producing a visible error. That is why `mapUserToRemna` omits `uuid` outright
 * instead of echoing it alongside `id`: the client prefers `uuid` when present,
 * and would adopt the value it then refuses to use.
 */

/**
 * A wire reference → the numeric handle it names, or null when it is not one.
 *
 * Deliberately strict: decimal digits only, no sign, no whitespace, positive,
 * and within the range JSON can carry losslessly. Anything else — a UUID, a
 * blank, `1e3`, a value past 2^53 — is NOT a reference this panel ever issued,
 * and guessing at it would risk answering about the wrong account.
 */
export function parseUserRef(raw: string | undefined): bigint | null {
  if (!raw || !/^[0-9]{1,16}$/.test(raw)) return null;
  const value = BigInt(raw);
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return value;
}

/**
 * A wire reference → the user it names.
 *
 * A malformed reference and an unknown one are the same answer on purpose: both
 * are "no such user", which the client normalizes to an empty lookup. A063 is
 * the code Remnawave 3.1+ reports for it; the client also accepts A025/A062 and
 * a bare 404, so the exact code is a courtesy rather than a contract.
 */
export async function resolveUserRef(raw: string | undefined): Promise<PublicUserDto> {
  const numericId = parseUserRef(raw);
  const dto = numericId === null ? null : await usersService.findUserByNumericId(numericId);
  if (!dto) throw new RemnaError(404, 'A063', 'user not found');
  return dto;
}

/** As resolveUserRef, but yielding the NATIVE id the services take. */
export async function resolveUserId(raw: string | undefined): Promise<string> {
  return (await resolveUserRef(raw)).id;
}
