import type { Prisma } from '../../generated/prisma/client.js';
import { ALL_SQUAD_ID, ALL_SQUAD_NAME, NO_ACCESS_SQUAD_ID, NO_ACCESS_SQUAD_NAME } from './squads.constants.js';

/** The seed migration's wording, so a repaired row reads like a seeded one. */
const ALL_SQUAD_DESCRIPTION = 'Default group containing every inbound. Auto-membership for new users.';

/**
 * Make sure the system "All" squad exists, inside the caller's transaction.
 *
 * It is seeded by a migration, and everything that attaches to it (a new
 * profile, a new user) assumed the row was there. On a database seeded or
 * cleaned some other way it was not, and every profile save answered 500 on a
 * foreign key (dev, 2026-09-23: a 10 000-user seed with two squads and no
 * "All"). The panel can repair that itself, so it does.
 *
 * The ROW only, never its membership: backfilling who is in "All" decides who
 * sees what, and that is not a thing to do as a side effect of saving a profile.
 *
 * If a squad named "All" already exists under another id (the name is unique),
 * the system row takes a name that says what it is instead of failing.
 */
export async function ensureAllSquad(tx: Prisma.TransactionClient): Promise<void> {
  const present = await tx.group.findUnique({ where: { id: ALL_SQUAD_ID }, select: { id: true } });
  if (present) return;
  const nameTaken = await tx.group.findUnique({ where: { name: ALL_SQUAD_NAME }, select: { id: true } });
  await tx.group.create({
    data: {
      id: ALL_SQUAD_ID,
      name: nameTaken ? `${ALL_SQUAD_NAME} (system)` : ALL_SQUAD_NAME,
      description: ALL_SQUAD_DESCRIPTION,
    },
  });
}

const NO_ACCESS_SQUAD_DESCRIPTION =
  'Users with no squad of their own. System-managed, has no profiles; do not edit or assign by hand.';

/**
 * Make sure the system "no access" squad exists, inside the caller's
 * transaction. Created on demand rather than by a migration, so a panel that
 * never uses it never gets the row.
 *
 * Two first-time callers at once must not fail each other: the insert skips a
 * duplicate id (ON CONFLICT DO NOTHING) instead of raising on it. If the name
 * is held by a squad of the operator's own, the row is made under a name that
 * says what it is, as for "All".
 */
export async function ensureNoAccessSquad(tx: Prisma.TransactionClient): Promise<void> {
  const create = (name: string) =>
    tx.group.createMany({
      data: [{ id: NO_ACCESS_SQUAD_ID, name, description: NO_ACCESS_SQUAD_DESCRIPTION }],
      skipDuplicates: true,
    });
  await create(NO_ACCESS_SQUAD_NAME);
  const present = await tx.group.findUnique({ where: { id: NO_ACCESS_SQUAD_ID }, select: { id: true } });
  if (present) return;
  // Skipped on the name: another squad holds it.
  await create(`${NO_ACCESS_SQUAD_NAME} (system)`);
}
