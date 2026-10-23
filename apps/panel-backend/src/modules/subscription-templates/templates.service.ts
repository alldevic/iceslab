import { TEMPLATE_FORMATS, TEMPLATE_TYPES, type SubscriptionFormat, type TemplateType } from '@iceslab/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../prisma.js';
import {
  DEFAULT_TEMPLATE_BODIES,
  DEFAULT_TEMPLATE_IDS,
  DEFAULT_TEMPLATE_NAME,
  DEFAULT_TEMPLATES_REVISION,
  defaultTypeOf,
  isReservedName,
} from './templates.defaults.js';
import { checkTemplateBody } from './templates.parse.js';

/**
 * A-236 step 2: subscription templates, the API contract 4.5a
 * (docs/plan/subscription-templates.md). The Default of each type is code
 * (templates.defaults.ts) until the operator edits it.
 */

export interface PublicTemplate {
  id: string;
  type: TemplateType;
  name: string;
  body: string;
  isDefault: boolean;
  updatedAt: string;
}

export class TemplateNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(what: string) {
    super(`Template ${what} not found`);
    this.name = 'TemplateNotFoundError';
  }
}

export class TemplateNameTakenError extends Error {
  readonly code = 'TEMPLATE_NAME_TAKEN';
  constructor(type: string, name: string) {
    super(
      isReservedName(name)
        ? `"${DEFAULT_TEMPLATE_NAME}" is the built-in template of every type: edit it, or pick another name`
        : `a ${type} template named "${name}" already exists`,
    );
    this.name = 'TemplateNameTakenError';
  }
}

export class TemplateDefaultProtectedError extends Error {
  readonly code = 'TEMPLATE_DEFAULT_PROTECTED';
  constructor(what: string) {
    super(`the ${DEFAULT_TEMPLATE_NAME} template ${what}: restore it to the built-in body instead`);
    this.name = 'TemplateDefaultProtectedError';
  }
}

export class TemplateNotDefaultError extends Error {
  readonly code = 'TEMPLATE_NOT_DEFAULT';
  constructor() {
    super(`only a ${DEFAULT_TEMPLATE_NAME} template has a built-in body to restore`);
    this.name = 'TemplateNotDefaultError';
  }
}

type Row = { id: string; type: string; name: string; body: string; updatedAt: Date };

function toDto(r: Row): PublicTemplate {
  return {
    id: r.id,
    type: r.type as TemplateType,
    name: r.name,
    body: r.body,
    isDefault: r.name === DEFAULT_TEMPLATE_NAME,
    updatedAt: r.updatedAt.toISOString(),
  };
}

function codeDefault(type: TemplateType): PublicTemplate {
  return {
    id: DEFAULT_TEMPLATE_IDS[type],
    type,
    name: DEFAULT_TEMPLATE_NAME,
    body: DEFAULT_TEMPLATE_BODIES[type],
    isDefault: true,
    updatedAt: DEFAULT_TEMPLATES_REVISION,
  };
}

// ---------------------------------------------------------------- cache

/**
 * In-process cache of the whole table, as the SRR rules are kept: the
 * subscription reads a template on every request, the operator writes one a
 * day. Dropped on every write here; a write through another process (a raw
 * SQL edit) is seen when the entry ages out.
 */
const CACHE_TTL_MS = 60_000;
let cache: { at: number; rows: Row[] } | null = null;

export function invalidateTemplateCache(): void {
  cache = null;
}

async function rows(): Promise<Row[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const all = await prisma.subscriptionTemplate.findMany({
    select: { id: true, type: true, name: true, body: true, updatedAt: true },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  });
  cache = { at: Date.now(), rows: all };
  return all;
}

// ---------------------------------------------------------------- reading

/** Every type's Default first (the edited row or the code), then the type's
 *  own templates by name, types in TEMPLATE_TYPES order. */
export async function listTemplates(): Promise<PublicTemplate[]> {
  const all = await rows();
  return TEMPLATE_TYPES.flatMap((type) => {
    const mine = all.filter((r) => r.type === type);
    const edited = mine.find((r) => r.name === DEFAULT_TEMPLATE_NAME);
    return [
      edited ? toDto(edited) : codeDefault(type),
      ...mine.filter((r) => r.name !== DEFAULT_TEMPLATE_NAME).map(toDto),
    ];
  });
}

/** The template of `type` named `name` (Default: the edited one or the code),
 *  or null. What the subscription asks for `?template=`. */
export async function findTemplate(type: TemplateType, name: string): Promise<PublicTemplate | null> {
  const all = await rows();
  const row = all.find((r) => r.type === type && r.name === name);
  if (row) return toDto(row);
  return name === DEFAULT_TEMPLATE_NAME ? codeDefault(type) : null;
}

/**
 * The template type a subscription format is framed by, for `?template=`.
 * `clash` answers mihomo until the stash and legacy clash answers ship (step
 * 4); a format no template frames answers null.
 */
export function templateTypeForFormat(format: SubscriptionFormat): TemplateType | null {
  if (format === 'clash') return 'mihomo';
  const hit = TEMPLATE_TYPES.find((t) => TEMPLATE_FORMATS[t] === format && t !== 'stash' && t !== 'clash');
  return hit ?? null;
}

// ---------------------------------------------------------------- writing

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function createTemplate(input: { type: TemplateType; name: string; body: string }): Promise<PublicTemplate> {
  const name = input.name.trim();
  if (isReservedName(name)) throw new TemplateNameTakenError(input.type, name);
  checkTemplateBody(input.type, input.body);
  try {
    const row = await prisma.subscriptionTemplate.create({ data: { type: input.type, name, body: input.body } });
    return toDto(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw new TemplateNameTakenError(input.type, name);
    throw err;
  } finally {
    invalidateTemplateCache();
  }
}

/**
 * An edit. A Default (by its fixed id) is written as a row on its first edit
 * and keeps its name; any other template may be renamed, but not to Default.
 * An absent key is not an edit.
 */
export async function updateTemplate(id: string, input: { name?: string; body?: string }): Promise<PublicTemplate> {
  const defaultType = defaultTypeOf(id);
  try {
    if (defaultType) {
      if (input.name !== undefined && input.name.trim() !== DEFAULT_TEMPLATE_NAME) {
        throw new TemplateDefaultProtectedError('keeps its name');
      }
      if (input.body === undefined) return (await findTemplate(defaultType, DEFAULT_TEMPLATE_NAME))!;
      checkTemplateBody(defaultType, input.body);
      const row = await prisma.subscriptionTemplate.upsert({
        where: { id },
        create: { id, type: defaultType, name: DEFAULT_TEMPLATE_NAME, body: input.body },
        update: { body: input.body },
      });
      return toDto(row);
    }

    const existing = await prisma.subscriptionTemplate.findUnique({ where: { id } });
    if (!existing) throw new TemplateNotFoundError(id);
    const type = existing.type as TemplateType;
    const name = input.name?.trim();
    if (name !== undefined && isReservedName(name)) throw new TemplateNameTakenError(type, name);
    if (input.body !== undefined) checkTemplateBody(type, input.body);
    try {
      const row = await prisma.subscriptionTemplate.update({
        where: { id },
        data: { ...(name !== undefined ? { name } : {}), ...(input.body !== undefined ? { body: input.body } : {}) },
      });
      return toDto(row);
    } catch (err) {
      if (isUniqueViolation(err) && name !== undefined) throw new TemplateNameTakenError(type, name);
      throw err;
    }
  } finally {
    invalidateTemplateCache();
  }
}

export async function deleteTemplate(id: string): Promise<void> {
  if (defaultTypeOf(id)) throw new TemplateDefaultProtectedError('is not deleted');
  try {
    await prisma.subscriptionTemplate.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') throw new TemplateNotFoundError(id);
    throw err;
  } finally {
    invalidateTemplateCache();
  }
}

/** Puts a Default back to the built-in body: its edited row goes. */
export async function restoreDefault(id: string): Promise<PublicTemplate> {
  const type = defaultTypeOf(id);
  if (!type) {
    const exists = await prisma.subscriptionTemplate.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new TemplateNotFoundError(id);
    throw new TemplateNotDefaultError();
  }
  await prisma.subscriptionTemplate.deleteMany({ where: { id } });
  invalidateTemplateCache();
  return codeDefault(type);
}
