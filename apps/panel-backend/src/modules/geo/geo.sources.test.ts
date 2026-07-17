import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import {
  addSource,
  deleteSource,
  getEnabledSources,
  getSources,
  updateSource,
  reorderSources,
} from './geo.sources.js';

// G1 - geo-source registry, stored as a JSON blob in app_settings (key
// geoSources). Runs against the test DB (docker compose postgres-test).

const KEY = 'geoSources';

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: KEY } });
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('geo source registry', () => {
  it('offers the curated runetfreedom default while untouched', async () => {
    const sources = await getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: 'default',
      name: 'runetfreedom (official)',
      trusted: true,
      enabled: true,
    });
    expect(sources[0]!.geositeUrl).toContain('geosite.dat');
    expect(sources[0]!.geoipUrl).toContain('geoip.dat');
  });

  it('reorders sources (priority = list order; first enabled with a db = mirror)', async () => {
    const a = await addSource({ name: 'a', geositeUrl: 'https://example.com/a.dat' });
    const b = await addSource({ name: 'b', geositeUrl: 'https://example.com/b.dat' });
    // insertion order: [default, a, b]
    const before = (await getSources()).map((s) => s.id);
    expect(before).toEqual(['default', a.id, b.id]);

    // promote b to the top
    const reordered = await reorderSources([b.id, a.id, 'default']);
    expect(reordered.map((s) => s.id)).toEqual([b.id, a.id, 'default']);
    expect((await getSources()).map((s) => s.id)).toEqual([b.id, a.id, 'default']);

    // a source omitted from the order is kept at the end (defensive)
    const partial = await reorderSources([a.id]);
    expect(partial[0]!.id).toBe(a.id);
    expect(partial.map((s) => s.id).sort()).toEqual([b.id, a.id, 'default'].sort());
  });

  it('adds a source (untrusted) and pins the default alongside it', async () => {
    const created = await addSource({
      name: 'my-list',
      geositeUrl: 'https://example.com/geosite.dat',
    });
    expect(created.id).not.toBe('default');
    expect(created.trusted).toBe(false);
    expect(created.geositeUrl).toBe('https://example.com/geosite.dat');
    expect(created.geoipUrl).toBeNull();

    const all = await getSources();
    expect(all.map((s) => s.id)).toContain('default'); // default did not vanish
    expect(all.map((s) => s.name)).toContain('my-list');
  });

  it('filters disabled sources out of getEnabledSources', async () => {
    const s = await addSource({ name: 'off', geoipUrl: 'https://example.com/geoip.dat' });
    await updateSource(s.id, { enabled: false });
    const enabled = await getEnabledSources();
    expect(enabled.map((x) => x.id)).not.toContain(s.id);
    expect(enabled.map((x) => x.id)).toContain('default');
  });

  it('renames / repoints / toggles via updateSource', async () => {
    const s = await addSource({ name: 'a', geositeUrl: 'https://example.com/a.dat' });
    const updated = await updateSource(s.id, {
      name: 'b',
      geoipUrl: 'https://example.com/b-ip.dat',
      enabled: false,
    });
    expect(updated).toMatchObject({ name: 'b', enabled: false });
    expect(updated!.geositeUrl).toBe('https://example.com/a.dat'); // unchanged (absent in patch)
    expect(updated!.geoipUrl).toBe('https://example.com/b-ip.dat');
  });

  it('refuses an update that would leave a source with no URL', async () => {
    const s = await addSource({ name: 'a', geositeUrl: 'https://example.com/a.dat' });
    const res = await updateSource(s.id, { geositeUrl: null });
    expect(res).toBeNull();
  });

  it('deletes a source', async () => {
    const s = await addSource({ name: 'gone', geositeUrl: 'https://example.com/g.dat' });
    expect(await deleteSource(s.id)).toBe(true);
    expect(await deleteSource(s.id)).toBe(false); // already gone
    expect((await getSources()).map((x) => x.id)).not.toContain(s.id);
  });

  it('rejects SSRF-y URLs (non-https / private / metadata host)', async () => {
    await expect(addSource({ name: 'x', geositeUrl: 'http://example.com/a.dat' })).rejects.toThrow(
      /https/,
    );
    await expect(
      addSource({ name: 'x', geoipUrl: 'https://169.254.169.254/latest/meta-data' }),
    ).rejects.toThrow(/not allowed/);
    await expect(addSource({ name: 'x', geositeUrl: 'https://localhost/a.dat' })).rejects.toThrow(
      /not allowed/,
    );
  });

  it('drops malformed stored entries defensively (coerce)', async () => {
    // Hand-write a blob with one valid + several junk entries.
    await prisma.appSetting.create({
      data: {
        key: KEY,
        value: [
          { id: 'ok', name: 'ok', geositeUrl: 'https://example.com/ok.dat', enabled: true },
          { id: 'no-url', name: 'no-url' }, // dropped: no geosite/geoip URL
          { name: 'no-id', geoipUrl: 'https://example.com/x.dat' }, // dropped: no id
          'not-an-object', // dropped
        ] as unknown as object,
        isPublic: false,
      },
    });
    const sources = await getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.id).toBe('ok');
  });
});
