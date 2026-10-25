import { api } from '@/lib/net/client';

/**
 * The node's connection log (owner's decision 26.10): whether the machine's
 * journal or syslog holds lines with clients' addresses, and a wipe of both.
 *
 * Shapes as BACK-2 gave them (packages/shared transport.ts, ConnLog*); kept
 * here until that commit lands, then read from shared. Every answer is
 * checked first: a malformed one is `null`, never «clean».
 */
export type ConnLogSource = 'journal' | 'syslog';
export type ConnLogCheckState = 'found' | 'clean' | 'absent' | 'failed';

export interface ConnLogSourceCheck {
  source: ConnLogSource;
  state: ConnLogCheckState;
  since: string | null;
  error?: string;
}

export interface ConnLogTrace {
  /** true: found; false: everything clean or absent; null: nothing found but a source failed. */
  present: boolean | null;
  since: string | null;
  sources: ConnLogSource[];
  checks: ConnLogSourceCheck[];
}

export interface ConnLogClearStep {
  command: string;
  ok: boolean;
  error?: string;
}

export interface ConnLogClearResult {
  source: ConnLogSource;
  state: 'cleared' | 'absent' | 'failed';
  steps: ConnLogClearStep[];
}

export interface ConnLogClear {
  results: ConnLogClearResult[];
  after: ConnLogTrace;
}

/** GET runs the check on the node: up to 60 s by the contract. */
export async function getConnLog(nodeId: string): Promise<unknown> {
  const { data } = await api.get<unknown>(`/api/nodes/${nodeId}/conn-log`, { timeout: 65_000 });
  return data;
}

/** POST wipes the journal and syslog: up to 120 s. */
export async function clearConnLog(nodeId: string): Promise<unknown> {
  const { data } = await api.post<unknown>(`/api/nodes/${nodeId}/conn-log/clear`, {}, { timeout: 125_000 });
  return data;
}

const SOURCES: readonly string[] = ['journal', 'syslog'];
const CHECK_STATES: readonly string[] = ['found', 'clean', 'absent', 'failed'];
const CLEAR_STATES: readonly string[] = ['cleared', 'absent', 'failed'];

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

export function connLogTraceOf(data: unknown): ConnLogTrace | null {
  const d = obj(data);
  if (!d) return null;
  if (!(d.present === null || typeof d.present === 'boolean') || !strOrNull(d.since)) return null;
  if (!Array.isArray(d.sources) || !Array.isArray(d.checks)) return null;
  const checks: ConnLogSourceCheck[] = [];
  for (const c of d.checks) {
    const r = obj(c);
    if (!r || typeof r.source !== 'string' || !SOURCES.includes(r.source)) return null;
    if (typeof r.state !== 'string' || !CHECK_STATES.includes(r.state) || !strOrNull(r.since)) return null;
    checks.push({
      source: r.source as ConnLogSource,
      state: r.state as ConnLogCheckState,
      since: r.since,
      ...(typeof r.error === 'string' ? { error: r.error } : {}),
    });
  }
  return {
    present: d.present as boolean | null,
    since: d.since,
    sources: d.sources.filter((s): s is ConnLogSource => typeof s === 'string' && SOURCES.includes(s)),
    checks,
  };
}

export function connLogClearOf(data: unknown): ConnLogClear | null {
  const d = obj(data);
  if (!d || !Array.isArray(d.results)) return null;
  const after = connLogTraceOf(d.after);
  if (!after) return null;
  const results: ConnLogClearResult[] = [];
  for (const x of d.results) {
    const r = obj(x);
    if (!r || typeof r.source !== 'string' || !SOURCES.includes(r.source)) return null;
    if (typeof r.state !== 'string' || !CLEAR_STATES.includes(r.state) || !Array.isArray(r.steps)) return null;
    const steps = r.steps.flatMap((s) => {
      const st = obj(s);
      if (!st || typeof st.command !== 'string' || typeof st.ok !== 'boolean') return [];
      return [{ command: st.command, ok: st.ok, ...(typeof st.error === 'string' ? { error: st.error } : {}) }];
    });
    results.push({ source: r.source as ConnLogSource, state: r.state as ConnLogClearResult['state'], steps });
  }
  return { results, after };
}

/**
 * The route's refusals: 409 UPDATE_AGENT (the agent is older than the
 * route, as with the certificate), 502 CONN_LOG_NODE_FAILED with the node's
 * words, 404 NOT_FOUND. Anything else is null, for the screen's usual reading.
 */
export type ConnLogRefusal =
  | { kind: 'update-agent' }
  | { kind: 'node-failed'; message: string }
  | { kind: 'not-found' };

export function connLogRefusal(err: unknown): ConnLogRefusal | null {
  const res = obj(obj(err)?.response);
  if (!res) return null;
  const data = obj(res.data);
  if (!data) return null;
  if (res.status === 409 && data.error === 'UPDATE_AGENT') return { kind: 'update-agent' };
  if (res.status === 502 && data.error === 'CONN_LOG_NODE_FAILED') {
    return { kind: 'node-failed', message: typeof data.message === 'string' ? data.message : '' };
  }
  if (res.status === 404 && data.error === 'NOT_FOUND') return { kind: 'not-found' };
  return null;
}
