import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../prisma.js';

/**
 * G3 persistence - operator-authored custom geo categories. Each spec composes
 * a category from chosen categories of registered sources (by sourceId) plus
 * hand-added domains/IPs and exclusions; the build orchestrator resolves the
 * sourceIds against fetched .dats and runs composeCategory. Stored as a JSON
 * blob in app_settings (key geoCategories), same migration-free pattern as
 * geoSources. No seeded default (an operator starts with none).
 */

const SETTINGS_KEY = 'geoCategories';

/** Pull one category from a registered source (source resolved at build time). */
export interface CategorySourceRef {
  sourceId: string;
  category: string;
}

export interface GeoCategorySpec {
  id: string;
  /** Custom category name, referenced as ext:<file>.dat:<name>. */
  name: string;
  domainRefs: CategorySourceRef[];
  ipRefs: CategorySourceRef[];
  manualDomains: string[];
  manualIps: string[];
  excludeDomains: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GeoCategoryInput {
  name: string;
  domainRefs?: CategorySourceRef[];
  ipRefs?: CategorySourceRef[];
  manualDomains?: string[];
  manualIps?: string[];
  excludeDomains?: string[];
  enabled?: boolean;
}

function coerceRefs(value: unknown): CategorySourceRef[] {
  if (!Array.isArray(value)) return [];
  const out: CategorySourceRef[] = [];
  for (const v of value) {
    if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      if (typeof r.sourceId === 'string' && typeof r.category === 'string' && r.category) {
        out.push({ sourceId: r.sourceId, category: r.category });
      }
    }
  }
  return out;
}

function coerceStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/** Defensive parse: drop entries without an id or a non-empty name. */
function coerceSpecs(value: unknown): GeoCategorySpec[] {
  if (!Array.isArray(value)) return [];
  const out: GeoCategorySpec[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') continue;
    const s = v as Record<string, unknown>;
    if (typeof s.id !== 'string' || typeof s.name !== 'string' || !s.name) continue;
    out.push({
      id: s.id,
      name: s.name,
      domainRefs: coerceRefs(s.domainRefs),
      ipRefs: coerceRefs(s.ipRefs),
      manualDomains: coerceStrings(s.manualDomains),
      manualIps: coerceStrings(s.manualIps),
      excludeDomains: coerceStrings(s.excludeDomains),
      enabled: s.enabled !== false,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : '',
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : '',
    });
  }
  return out;
}

export async function getCategories(): Promise<GeoCategorySpec[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
  return row ? coerceSpecs(row.value) : [];
}

export async function getEnabledCategories(): Promise<GeoCategorySpec[]> {
  return (await getCategories()).filter((c) => c.enabled);
}

async function mutate<T>(
  apply: (specs: GeoCategorySpec[]) => { next: GeoCategorySpec[]; result: T },
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SETTINGS_KEY}))`;
    const row = await tx.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const current = row ? coerceSpecs(row.value) : [];
    const { next, result } = apply(current);
    const value = next as unknown as Prisma.InputJsonValue;
    await tx.appSetting.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, value, isPublic: false },
      update: { value },
    });
    return result;
  });
}

/** Thrown when a category name collides (case-insensitively) with an existing
 *  one. The uppercased name is the artifact key AND the inline-lookup key, so a
 *  duplicate would silently drop one spec's data and make geo-custom.dat
 *  disagree with getCategoryDomains. Mapped to 409 in the route. */
export class GeoCategoryNameConflict extends Error {
  constructor(name: string) {
    super(`a geo category named "${name}" already exists`);
    this.name = 'GeoCategoryNameConflict';
  }
}

function normalizeInput(input: GeoCategoryInput): Omit<GeoCategorySpec, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: input.name.trim(),
    domainRefs: coerceRefs(input.domainRefs),
    ipRefs: coerceRefs(input.ipRefs),
    manualDomains: coerceStrings(input.manualDomains),
    manualIps: coerceStrings(input.manualIps),
    excludeDomains: coerceStrings(input.excludeDomains),
    enabled: input.enabled ?? true,
  };
}

export async function addCategory(input: GeoCategoryInput): Promise<GeoCategorySpec> {
  const now = new Date().toISOString();
  const spec: GeoCategorySpec = {
    id: randomUUID(),
    ...normalizeInput(input),
    createdAt: now,
    updatedAt: now,
  };
  const key = spec.name.toUpperCase();
  return mutate((specs) => {
    if (specs.some((s) => s.name.toUpperCase() === key)) {
      throw new GeoCategoryNameConflict(spec.name);
    }
    return { next: [...specs, spec], result: spec };
  });
}

export async function updateCategory(
  id: string,
  patch: Partial<GeoCategoryInput>,
): Promise<GeoCategorySpec | null> {
  return mutate((specs) => {
    const idx = specs.findIndex((s) => s.id === id);
    if (idx === -1) return { next: specs, result: null };
    const existing = specs[idx]!;
    const norm = normalizeInput({ ...existing, ...patch });
    // Reject a rename that collides (case-insensitively) with another spec.
    const key = norm.name.toUpperCase();
    if (specs.some((s) => s.id !== id && s.name.toUpperCase() === key)) {
      throw new GeoCategoryNameConflict(norm.name);
    }
    const updated: GeoCategorySpec = {
      ...existing,
      ...norm,
      updatedAt: new Date().toISOString(),
    };
    const next = [...specs];
    next[idx] = updated;
    return { next, result: updated };
  });
}

export async function deleteCategory(id: string): Promise<boolean> {
  return mutate((specs) => {
    const next = specs.filter((s) => s.id !== id);
    return { next, result: next.length !== specs.length };
  });
}
