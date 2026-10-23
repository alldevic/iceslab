import { ROUTING_PRESET_IDS, isRoutingPresetId } from '@iceslab/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../prisma.js';
import { BUILTIN_PRESET_RULES, checkRules, type DeviceRouteRule } from './routing-presets.rules.js';

/**
 * A-229 part 2: the list and the writes of device routing presets. The three
 * built-ins are listed with the operator's own and are read-only: the server
 * refuses to change or delete them, not only the screen.
 */

export interface PublicRoutingPresetRule extends DeviceRouteRule {
  /** Stable within one answer: `<presetId>:<index>`. The rules carry no id of
   *  their own; the screen keys its rows by this. */
  id: string;
}

export interface PublicRoutingPreset {
  id: string;
  name: string;
  builtIn: boolean;
  rules: PublicRoutingPresetRule[];
}

export interface RoutingPresetInput {
  name?: string;
  rules?: DeviceRouteRule[];
}

export interface PresetUse {
  users: { id: string; username: string }[];
  squads: { id: string; name: string }[];
  /** Totals: the lists above are capped, the counts are not. */
  userCount: number;
  squadCount: number;
}

export class RoutingPresetBuiltInError extends Error {
  readonly code = 'ROUTING_PRESET_BUILT_IN';
  constructor(id: string) {
    super(`"${id}" is a built-in preset: it cannot be changed or deleted. Make an own preset from its rules instead.`);
    this.name = 'RoutingPresetBuiltInError';
  }
}

export class RoutingPresetMissingError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(id: string) {
    super(`Routing preset ${id} not found`);
    this.name = 'RoutingPresetMissingError';
  }
}

export class RoutingPresetNameTakenError extends Error {
  readonly code = 'NAME_TAKEN';
  constructor(name: string) {
    super(
      isRoutingPresetId(name)
        ? `"${name}" is the name of a built-in preset`
        : `A routing preset named "${name}" already exists`,
    );
    this.name = 'RoutingPresetNameTakenError';
  }
}

export class RoutingPresetInUseError extends Error {
  readonly code = 'ROUTING_PRESET_IN_USE';
  constructor(public readonly use: PresetUse) {
    const parts = [
      use.userCount > 0 ? `${use.userCount} user(s)` : '',
      use.squadCount > 0 ? `${use.squadCount} squad(s)` : '',
    ].filter(Boolean);
    super(`the preset is assigned to ${parts.join(' and ')}: move them to another preset first`);
    this.name = 'RoutingPresetInUseError';
  }
}

const USE_LIST_CAP = 50;

function withIds(presetId: string, rules: readonly DeviceRouteRule[]): PublicRoutingPresetRule[] {
  return rules.map((r, i) => ({ id: `${presetId}:${i}`, match: [...r.match], action: r.action, note: r.note }));
}

function toDto(row: { id: string; name: string; rules: unknown }): PublicRoutingPreset {
  const rules = Array.isArray(row.rules) ? (row.rules as DeviceRouteRule[]) : [];
  return { id: row.id, name: row.name, builtIn: false, rules: withIds(row.id, rules) };
}

export function builtInPresets(): PublicRoutingPreset[] {
  return ROUTING_PRESET_IDS.map((id) => ({ id, name: id, builtIn: true, rules: withIds(id, BUILTIN_PRESET_RULES[id]) }));
}

export async function listRoutingPresets(): Promise<PublicRoutingPreset[]> {
  const own = await prisma.routingPreset.findMany({ orderBy: [{ name: 'asc' }] });
  return [...builtInPresets(), ...own.map(toDto)];
}

function stored(rules: readonly DeviceRouteRule[]): Prisma.InputJsonValue {
  return rules.map((r) => ({ match: r.match, action: r.action, note: r.note }));
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function nameFree(name: string, exceptId?: string): Promise<void> {
  if (isRoutingPresetId(name)) throw new RoutingPresetNameTakenError(name);
  const other = await prisma.routingPreset.findUnique({ where: { name }, select: { id: true } });
  if (other && other.id !== exceptId) throw new RoutingPresetNameTakenError(name);
}

export async function createRoutingPreset(input: Required<RoutingPresetInput>): Promise<PublicRoutingPreset> {
  await nameFree(input.name);
  await checkRules(input.rules);
  try {
    const row = await prisma.routingPreset.create({ data: { name: input.name, rules: stored(input.rules) } });
    return toDto(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw new RoutingPresetNameTakenError(input.name);
    throw err;
  }
}

/** `id` as the URL gave it: a built-in key is refused in words before the
 *  uuid check would call it malformed. */
export function refuseBuiltIn(id: string): void {
  if (isRoutingPresetId(id)) throw new RoutingPresetBuiltInError(id);
}

export async function updateRoutingPreset(id: string, input: RoutingPresetInput): Promise<PublicRoutingPreset> {
  const existing = await prisma.routingPreset.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new RoutingPresetMissingError(id);
  // An absent key is not an edit: a name-only save keeps the rules.
  if (input.name !== undefined) await nameFree(input.name, id);
  if (input.rules !== undefined) await checkRules(input.rules);
  try {
    const row = await prisma.routingPreset.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.rules !== undefined ? { rules: stored(input.rules) } : {}),
      },
    });
    return toDto(row);
  } catch (err) {
    if (isUniqueViolation(err) && input.name !== undefined) throw new RoutingPresetNameTakenError(input.name);
    throw err;
  }
}

/** Who holds the preset: live users and every squad. */
export async function presetUse(id: string): Promise<PresetUse> {
  const userWhere = { customRoutingPresetId: id, deletedAt: null };
  const [users, userCount, squads, squadCount] = await Promise.all([
    prisma.user.findMany({ where: userWhere, select: { id: true, username: true }, orderBy: { username: 'asc' }, take: USE_LIST_CAP }),
    prisma.user.count({ where: userWhere }),
    prisma.group.findMany({ where: { customRoutingPresetId: id }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: USE_LIST_CAP }),
    prisma.group.count({ where: { customRoutingPresetId: id } }),
  ]);
  return { users, squads, userCount, squadCount };
}

/**
 * Deletes an own preset nobody holds. One in use is refused with who holds it
 * (409 ROUTING_PRESET_IN_USE), before the foreign key's RESTRICT would answer
 * with a bare constraint error. A soft-deleted user still carries the column
 * and is not "using" anything: its pointer is cleared in the same transaction,
 * or RESTRICT would keep the preset alive for a row nobody can see.
 */
export async function deleteRoutingPreset(id: string): Promise<void> {
  const existing = await prisma.routingPreset.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new RoutingPresetMissingError(id);
  const use = await presetUse(id);
  if (use.userCount > 0 || use.squadCount > 0) throw new RoutingPresetInUseError(use);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.updateMany({
        where: { customRoutingPresetId: id, deletedAt: { not: null } },
        data: { customRoutingPresetId: null },
      });
      await tx.routingPreset.delete({ where: { id } });
    });
  } catch (err) {
    // Assigned between the check above and the delete: RESTRICT refuses, and
    // that is the same fact the check would have found. Said the same way,
    // with the holders read again.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      throw new RoutingPresetInUseError(await presetUse(id));
    }
    throw err;
  }
}
