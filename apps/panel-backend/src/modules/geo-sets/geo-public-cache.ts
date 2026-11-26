import { prisma } from '../../prisma.js';

/**
 * The bytes of a served geo file, by sha256. The content under a sha256 never
 * changes, so an entry is never stale; it only has to be bounded. The files are
 * tens of megabytes in a Postgres `bytea`, and the address is public with one
 * token for everybody: reading them from the table on every request is not an
 * option. The backend image writes nothing to disk (geo.prisma), so this is in
 * the process: least recently used goes first, the total stays under the cap.
 * A file larger than the cap is served and not kept.
 */
export const GEO_PUBLIC_CACHE_MAX_BYTES = 256 * 1024 * 1024;

const entries = new Map<string, Buffer>();
const loading = new Map<string, Promise<Buffer | null>>();
let total = 0;

function keep(sha256: string, data: Buffer): void {
  if (data.length > GEO_PUBLIC_CACHE_MAX_BYTES) return;
  total += data.length;
  entries.set(sha256, data);
  for (const [k, v] of entries) {
    if (total <= GEO_PUBLIC_CACHE_MAX_BYTES) break;
    if (k === sha256) continue;
    entries.delete(k);
    total -= v.length;
  }
}

/** The file's bytes, or null when no blob has this sha256. Concurrent misses share one read. */
export async function geoPublicBytes(sha256: string): Promise<Buffer | null> {
  const hit = entries.get(sha256);
  if (hit) {
    // Re-insert: Map order is the recency order.
    entries.delete(sha256);
    entries.set(sha256, hit);
    return hit;
  }
  const pending = loading.get(sha256);
  if (pending) return pending;
  const read = (async () => {
    const row = await prisma.geoBlob.findUnique({ where: { sha256 }, select: { data: true } });
    if (!row) return null;
    const data = Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength);
    keep(sha256, data);
    return data;
  })().finally(() => loading.delete(sha256));
  loading.set(sha256, read);
  return read;
}

/** For tests. */
export function resetGeoPublicCache(): void {
  entries.clear();
  loading.clear();
  total = 0;
}

export function geoPublicCacheStats(): { files: number; bytes: number } {
  return { files: entries.size, bytes: total };
}
