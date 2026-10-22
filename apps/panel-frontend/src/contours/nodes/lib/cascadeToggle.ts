/**
 * The server's refusal to switch a cascade on, in its own words (A-126).
 *
 * Since 1bf18ca switching a cascade on runs the topology gates on the stored
 * cascade, so `{ enabled: true }` alone can be refused: 400 INVALID for a
 * node that is gone, or any of the gate codes (CELL_NOT_CARRIED and the rest)
 * with a message that names the node. The card keeps the cascade drawn as off
 * (it never flips before the server answers) and puts these words under it.
 *
 * Input checked first. Null means "not a refusal the server explained": a
 * network failure or a 5xx stays a toast.
 */
export function cascadeToggleRefusal(err: unknown): { code: string; message: string } | null {
  if (!err || typeof err !== 'object') return null;
  const res = (err as { response?: unknown }).response;
  if (!res || typeof res !== 'object') return null;
  const { status, data } = res as { status?: unknown; data?: unknown };
  if (typeof status !== 'number' || status < 400 || status >= 500 || !data || typeof data !== 'object') return null;
  const { error, message } = data as { error?: unknown; message?: unknown };
  if (typeof message !== 'string' || message === '') return null;
  return { code: typeof error === 'string' ? error : '', message };
}
