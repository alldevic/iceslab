import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import {
  addCategory,
  deleteCategory,
  getCategories,
  getEnabledCategories,
  updateCategory,
  GeoCategoryNameConflict,
} from './geo.categories.js';

const KEY = 'geoCategories';

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: KEY } });
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('geo custom-category persistence', () => {
  it('starts empty (no seeded default)', async () => {
    expect(await getCategories()).toEqual([]);
  });

  it('rejects a case-insensitive duplicate name (avoids silent data loss)', async () => {
    await addCategory({ name: 'ads' });
    await expect(addCategory({ name: 'ADS' })).rejects.toBeInstanceOf(GeoCategoryNameConflict);
    // renaming an existing one onto another's name is rejected too
    const b = await addCategory({ name: 'video' });
    await expect(updateCategory(b.id, { name: 'Ads' })).rejects.toBeInstanceOf(
      GeoCategoryNameConflict,
    );
    // renaming a category to its own name (different case) is fine
    const same = await updateCategory(b.id, { name: 'VIDEO' });
    expect(same?.name).toBe('VIDEO');
  });

  it('adds a category with normalized defaults', async () => {
    const c = await addCategory({
      name: '  my-block  ',
      domainRefs: [{ sourceId: 's1', category: 'youtube' }],
      manualDomains: ['vimeo.com', '  '],
    });
    expect(c.id).toBeTruthy();
    expect(c.name).toBe('my-block'); // trimmed
    expect(c.enabled).toBe(true);
    expect(c.domainRefs).toEqual([{ sourceId: 's1', category: 'youtube' }]);
    expect(c.manualDomains).toEqual(['vimeo.com']); // blank dropped
    expect(c.ipRefs).toEqual([]);
    expect(c.excludeDomains).toEqual([]);
  });

  it('filters disabled from getEnabledCategories', async () => {
    const c = await addCategory({ name: 'off', enabled: false, manualDomains: ['x.com'] });
    expect((await getEnabledCategories()).map((x) => x.id)).not.toContain(c.id);
  });

  it('patches fields, preserving the rest', async () => {
    const c = await addCategory({
      name: 'a',
      domainRefs: [{ sourceId: 's1', category: 'youtube' }],
      manualDomains: ['a.com'],
    });
    const up = await updateCategory(c.id, { name: 'b', enabled: false });
    expect(up).toMatchObject({ name: 'b', enabled: false });
    expect(up!.domainRefs).toEqual([{ sourceId: 's1', category: 'youtube' }]); // preserved
    expect(up!.manualDomains).toEqual(['a.com']); // preserved
  });

  it('returns null updating a missing id', async () => {
    expect(await updateCategory('nope', { name: 'x' })).toBeNull();
  });

  it('deletes a category', async () => {
    const c = await addCategory({ name: 'gone', manualIps: ['1.2.3.0/24'] });
    expect(await deleteCategory(c.id)).toBe(true);
    expect(await deleteCategory(c.id)).toBe(false);
    expect(await getCategories()).toEqual([]);
  });

  it('coerces malformed stored entries defensively', async () => {
    await prisma.appSetting.create({
      data: {
        key: KEY,
        value: [
          { id: 'ok', name: 'ok', manualDomains: ['a.com'] },
          { id: 'no-name' }, // dropped: no name
          { name: 'no-id' }, // dropped: no id
        ] as unknown as object,
        isPublic: false,
      },
    });
    const specs = await getCategories();
    expect(specs).toHaveLength(1);
    expect(specs[0]!.id).toBe('ok');
  });
});
