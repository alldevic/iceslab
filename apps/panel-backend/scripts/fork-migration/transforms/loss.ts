import type { Client } from '../pgutil.js';
import { rows } from '../pgutil.js';
import type { Report } from '../report.js';
import { step } from '../report.js';
import { LOSSY_KEYS } from '../stored-content.js';

/** --accept-loss: the fields the new fork dropped are taken out of the stored configs, so what is stored is what is served. */
export function stripLossy(v: Record<string, unknown> | null): { next: Record<string, unknown>; removed: string[] } | null {
  if (!v) return null;
  const removed = Object.keys(v).filter((k) => (LOSSY_KEYS as readonly string[]).includes(k));
  if (!removed.length) return null;
  const next = { ...v };
  for (const k of removed) delete next[k];
  return { next, removed };
}

export async function lossStep(c: Client, report: Report): Promise<void> {
  const done: Array<{ where: string; name: string; removed: string[] }> = [];
  for (const p of await rows<{ id: string; name: string; config: Record<string, unknown> | null }>(c, `SELECT id, name, config FROM profiles`)) {
    const s = stripLossy(p.config);
    if (!s) continue;
    await c.query(`UPDATE profiles SET config = $1::jsonb WHERE id = $2`, [JSON.stringify(s.next), p.id]);
    done.push({ where: 'profile', name: p.name, removed: s.removed });
  }
  for (const b of await rows<{ id: string; name: string; overrides: Record<string, unknown> | null }>(
    c,
    `SELECT b.id, p.name, b.overrides FROM profile_node_bindings b JOIN profiles p ON p.id = b.profile_id WHERE b.overrides IS NOT NULL`,
  )) {
    const s = stripLossy(b.overrides);
    if (!s) continue;
    await c.query(`UPDATE profile_node_bindings SET overrides = $1::jsonb WHERE id = $2`, [JSON.stringify(s.next), b.id]);
    done.push({ where: 'binding overrides', name: b.name, removed: s.removed });
  }
  step(report, { step: 'accept-loss', status: 'done', summary: `${done.length} stored configs lost post-quantum / abusePolicy fields`, details: done });
  report.data['lossApplied'] = done;
}
