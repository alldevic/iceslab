/** What a run says about itself: findings that stop it, ones that do not, and
 *  the steps it took. Written as JSON for the operator and the stand. */
export interface Finding {
  code: string;
  message: string;
  /** Machine-readable evidence: names, counts, values the operator needs. */
  details?: unknown;
}

export interface StepLog {
  step: string;
  status: 'done' | 'skipped' | 'failed';
  /** was / became / skipped, in words and numbers. */
  summary: string;
  details?: unknown;
}

export interface Report {
  version: 1;
  mode: string;
  startedAt: string;
  finishedAt?: string;
  source?: string;
  target?: string;
  blocking: Finding[];
  warnings: Finding[];
  info: Finding[];
  steps: StepLog[];
  /** Named blocks the stand and the document read: counts, checksums, the lists. */
  data: Record<string, unknown>;
}

export function newReport(mode: string): Report {
  return { version: 1, mode, startedAt: new Date().toISOString(), blocking: [], warnings: [], info: [], steps: [], data: {} };
}

export const block = (r: Report, code: string, message: string, details?: unknown): void => {
  r.blocking.push({ code, message, ...(details === undefined ? {} : { details }) });
};
export const warn = (r: Report, code: string, message: string, details?: unknown): void => {
  r.warnings.push({ code, message, ...(details === undefined ? {} : { details }) });
};
export const note = (r: Report, code: string, message: string, details?: unknown): void => {
  r.info.push({ code, message, ...(details === undefined ? {} : { details }) });
};
export const step = (r: Report, s: StepLog): void => {
  r.steps.push(s);
};
