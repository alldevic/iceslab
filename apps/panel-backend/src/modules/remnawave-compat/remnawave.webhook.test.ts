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
