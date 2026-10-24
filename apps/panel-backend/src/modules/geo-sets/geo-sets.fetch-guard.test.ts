import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { GEO_FILE_MAX_BYTES } from '@iceslab/shared';
import { fetchUrl } from './geo-sets.store.js';
import { createUrlSet, GeoSetInvalidError } from './geo-sets.service.js';
import { isBlockedHost } from '../../lib/util/guarded-fetch.js';

/**
 * A-115: a geo set fetched from an operator's URL gets the guards the recipe
 * sources have: the body is refused as soon as it passes the ceiling, not
 * after it was all held in memory, and every address on the way (the URL and
 * each redirect) has to be a public host.
 */

const URL_ = 'https://lists.example.com/big.dat';

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function urlSet(url = URL_) {
  return prisma.geoSet.create({
    data: { name: 'big', kind: 'geosite', sourceType: 'url', url, sha256Source: 'manual', sha256Manual: 'ab'.repeat(32) },
    select: { id: true },
  });
}

describe('the body', () => {
  it('a stream past the ceiling with no Content-Length is cut off, the rest never read', async () => {
    const { id } = await urlSet();
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 10_000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const f = (async () => new Response(endless)) as typeof fetch;
    const out = await fetchUrl(id, f);
    expect(out).toMatchObject({ status: 'broken', error: expect.stringContaining('larger than') });
    // Stopped a chunk or two past the ceiling, not at the end of the stream.
    expect(pulled).toBeLessThan(GEO_FILE_MAX_BYTES / chunk.byteLength + 4);
  });

  it('a Content-Length past the ceiling is refused before any of the body is read', async () => {
    const { id } = await urlSet();
    let read = false;
    // highWaterMark 0: the stream pulls only when somebody reads.
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          read = true;
        },
      },
      { highWaterMark: 0 },
    );
    const f = (async () =>
      new Response(body, { headers: { 'content-length': String(GEO_FILE_MAX_BYTES + 1) } })) as typeof fetch;
    expect(await fetchUrl(id, f)).toMatchObject({ status: 'broken', error: expect.stringContaining('larger than') });
    expect(read).toBe(false);
  });
});

describe('the addresses', () => {
  it('a redirect to a private or metadata host is refused, and so is a fourth redirect', async () => {
    const { id } = await urlSet();
    const toMetadata = (async () =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })) as typeof fetch;
    expect(await fetchUrl(id, toMetadata)).toMatchObject({
      status: 'broken',
      error: expect.stringContaining('169.254.169.254 is not fetched'),
    });

    let hops = 0;
    const loop = (async () => {
      hops += 1;
      return new Response(null, { status: 301, headers: { location: `https://lists.example.com/hop${hops}` } });
    }) as typeof fetch;
    expect(await fetchUrl(id, loop)).toMatchObject({ status: 'broken', error: expect.stringContaining('more than 3 redirects') });
    expect(hops).toBe(4);
  });

  it('a set whose URL is a private host is refused when it is added, in words', async () => {
    for (const url of ['http://127.0.0.1/x.dat', 'https://10.0.0.5/x.dat', 'http://[::1]/x.dat', 'http://router.local/x.dat']) {
      await expect(
        createUrlSet({ name: 'inner', kind: 'geosite', source: { type: 'url', url, sha256Source: 'sidecar' } }),
        url,
      ).rejects.toBeInstanceOf(GeoSetInvalidError);
    }
    expect(isBlockedHost('lists.example.com')).toBe(false);
  });
});
