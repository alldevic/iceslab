import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildRemnaWebhookBody, type RemnaWebhookUser } from './remnawave.webhook.js';

const user = (o: Partial<RemnaWebhookUser> = {}): RemnaWebhookUser => ({
  id: 'u-1',
  telegramId: 12345n,
  email: 'a@b.c',
  expireAt: new Date('2026-03-04T05:06:07.008Z'),
  ...o,
});

describe('buildRemnaWebhookBody — exact minishop wire shape', () => {
  it('nests user under payload.user with the read fields, name + meta at top level', () => {
    const parsed = JSON.parse(buildRemnaWebhookBody('user.expired', user(), { a: 1 }));
    expect(parsed).toEqual({
      name: 'user.expired',
      payload: {
        user: {
          uuid: 'u-1',
          telegramId: 12345,
          email: 'a@b.c',
          expireAt: '2026-03-04T05:06:07.008Z',
        },
      },
      meta: { a: 1 },
    });
  });

  it('coerces BigInt telegramId to a number instead of throwing on JSON.stringify', () => {
    // A bare JSON.stringify over a bigint throws — the emitter must convert.
    expect(() => buildRemnaWebhookBody('user.expires_in_24_hours', user({ telegramId: 99n }))).not.toThrow();
    const parsed = JSON.parse(buildRemnaWebhookBody('user.expires_in_24_hours', user({ telegramId: 99n })));
    expect(parsed.payload.user.telegramId).toBe(99);
    expect(typeof parsed.payload.user.telegramId).toBe('number');
  });

  it('nulls absent identity fields; empty meta by default', () => {
    const parsed = JSON.parse(
      buildRemnaWebhookBody('user.expired', user({ telegramId: null, email: null, expireAt: null })),
    );
    expect(parsed.payload.user).toEqual({ uuid: 'u-1', telegramId: null, email: null, expireAt: null });
    expect(parsed.meta).toEqual({});
  });
});

describe('webhook signature scheme (X-Remnawave-Signature)', () => {
  // The minishop verifies hmac_sha256(secret, RAW_BODY).hexdigest() — no
  // timestamp prefix (that's the native bus). Lock the scheme: signing the
  // exact emitted body string with the shared secret yields a 64-char hex
  // digest, deterministic, and sensitive to both body and secret.
  const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

  it('is a deterministic 64-char hex over the raw body', () => {
    const body = buildRemnaWebhookBody('user.expired', user());
    const sig = sign('shared-secret', body);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sign('shared-secret', body)).toBe(sig);
  });

  it('changes when the body changes and when the secret changes', () => {
    const b1 = buildRemnaWebhookBody('user.expired', user());
    const b2 = buildRemnaWebhookBody('user.expires_in_24_hours', user());
    expect(sign('s', b1)).not.toBe(sign('s', b2));
    expect(sign('s1', b1)).not.toBe(sign('s2', b1));
  });
});

describe('the signed body is pure ASCII (live-risk 5: proxies between us and the shop)', () => {
  // The shop verifies HMAC over the RAW body, so the check passes only if the
  // bytes it reads are the bytes we signed - and between the two there is
  // whatever reverse proxy or CDN the operator runs. Anything that re-encodes
  // character sets changes non-ASCII bytes and nothing else, which is why this
  // failure would show up as a 401 for one subscriber with an accented address
  // and be invisible for everyone else.
  const nonAscii = (o: Partial<RemnaWebhookUser> = {}) =>
    user({ email: 'почта@пример.рф', ...o });

  it('escapes every non-ASCII character rather than emitting UTF-8', () => {
    const body = buildRemnaWebhookBody('user.expired', nonAscii());
    expect(body).toMatch(/^[\x00-\x7F]*$/);
    expect(body).toContain('\\u043f'); // п, escaped
  });

  it('still says exactly the same thing to a JSON parser', () => {
    const parsed = JSON.parse(buildRemnaWebhookBody('user.expired', nonAscii()));
    expect(parsed.payload.user.email).toBe('почта@пример.рф');
  });

  it('survives characters outside the basic plane, as a surrogate pair', () => {
    const parsed = JSON.parse(buildRemnaWebhookBody('user.expired', user({ email: 'a🎉@b.c' })));
    expect(parsed.payload.user.email).toBe('a🎉@b.c');
  });

  it('signs the ASCII bytes, so the digest is over what a proxy cannot alter', () => {
    const body = buildRemnaWebhookBody('user.expired', nonAscii());
    const sig = createHmac('sha256', 's').update(body).digest('hex');
    // Re-reading the body as UTF-8 bytes and as ASCII bytes must give the same
    // digest, because there is no byte above 0x7F to disagree about.
    expect(createHmac('sha256', 's').update(Buffer.from(body, 'utf8')).digest('hex')).toBe(sig);
    expect(createHmac('sha256', 's').update(Buffer.from(body, 'latin1')).digest('hex')).toBe(sig);
  });
});
