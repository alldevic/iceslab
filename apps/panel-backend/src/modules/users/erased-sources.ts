import { createHash } from 'node:crypto';
import { prisma } from '../../prisma.js';

/**
 * A-268 tombstone: what is kept of an imported user once they are erased for
 * good. The sha256 of their source id and nothing else, so an import run of
 * the same source can be refused without the panel holding the id or anything
 * about the person.
 */
export function sourceIdSha256(sourceId: string): string {
  return createHash('sha256').update(sourceId, 'utf8').digest('hex');
}

export async function isSourceIdErased(sourceId: string): Promise<boolean> {
  return (await prisma.erasedUserSource.count({ where: { sourceIdSha256: sourceIdSha256(sourceId) } })) > 0;
}
