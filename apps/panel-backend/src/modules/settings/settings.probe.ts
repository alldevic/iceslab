/**
 * The delivery probe's verdict (A-137, 22.10): did the SUBSCRIPTION ROUTE
 * answer, not just something at that address.
 *
 * The probe asks for a token nobody owns, and the route's answer to that is a
 * 404 with `{ error: 'NOT_FOUND', message: 'Subscription not found' }`
 * (subscription.routes.ts, SubscriptionNotFoundError). Anything else is not the
 * route: the SPA's index.html with 200 (a prefix the frontend's nginx does not
 * route), a proxy's own 404 page, a login redirect. The probe counted any
 * status under 500 as an answer, and was green on all of them.
 */
export function subscriptionProbeAnswered(status: number, contentType: string, body: string): boolean {
  if (status !== 404 || !contentType.toLowerCase().includes('application/json')) return false;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    return parsed.error === 'NOT_FOUND' && parsed.message === 'Subscription not found';
  } catch {
    return false;
  }
}

/** The first `max` bytes of a body as text, the rest drained so the socket is
 *  released (undici keeps it otherwise, and the next probe queues behind it). */
export async function readCapped(body: AsyncIterable<Uint8Array> & { dump(): Promise<void> }, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const b = Buffer.from(chunk);
    chunks.push(b.subarray(0, Math.max(0, max - size)));
    size += b.length;
    if (size >= max) break;
  }
  await body.dump().catch(() => undefined);
  return Buffer.concat(chunks).toString('utf8');
}
