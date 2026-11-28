import type { Client } from '../pgutil.js';
import { rows } from '../pgutil.js';
import type { Report } from '../report.js';
import { step } from '../report.js';

/**
 * nodes.hardening: the three keys omega's strict schema does not know are
 * taken out, or a PUT of the node answers 400 (zapret2 and the non-xray bridge
 * are not carried over; the egress policy was converted by egress.ts, which has
 * to run first). The values go to the report: the operator may want them.
 */
export const REMOVED_HARDENING_KEYS = ['egressPolicy', 'zapret2', 'bridgeNonXrayInbounds'] as const;

export function stripHardening(h: unknown): { next: Record<string, unknown>; removed: Record<string, unknown> } | null {
  if (h === null || typeof h !== 'object' || Array.isArray(h)) return null;
  const next: Record<string, unknown> = { ...(h as Record<string, unknown>) };
  const removed: Record<string, unknown> = {};
  for (const k of REMOVED_HARDENING_KEYS) {
    if (k in next) {
      removed[k] = next[k];
      delete next[k];
    }
  }
  return Object.keys(removed).length > 0 ? { next, removed } : null;
}

export async function stripHardeningStep(c: Client, report: Report): Promise<void> {
  const nodes = await rows<{ id: string; name: string; hardening: unknown }>(c, `SELECT id, name, hardening FROM nodes WHERE hardening IS NOT NULL`);
  const removedByNode: Array<{ node: string; removed: Record<string, unknown> }> = [];
  for (const n of nodes) {
    const s = stripHardening(n.hardening);
    if (!s) continue;
    await c.query(`UPDATE nodes SET hardening = $1::jsonb WHERE id = $2`, [JSON.stringify(s.next), n.id]);
    removedByNode.push({ node: n.name, removed: s.removed });
  }
  step(report, {
    step: 'hardening-strip',
    status: 'done',
    summary: `${removedByNode.length} of ${nodes.length} nodes had keys of the old fork in hardening; taken out`,
    details: removedByNode,
  });
  report.data['hardeningRemoved'] = removedByNode;
}
