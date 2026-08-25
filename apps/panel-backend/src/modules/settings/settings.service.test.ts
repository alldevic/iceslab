// What the subscriber is TOLD, as opposed to what they get.
//
// Measured before writing: the suite of 1513 stayed green with `formatBytes`
// returning "0 B" for every input and with `renderAnnounce` substituting
// nothing - so the banner an operator writes for their customers, and the
// "traffic left" figure inside it, were checked by nobody. (The one thing that
// WAS observed here is the settings cache bust, which the entry-pool test
// catches, so it is not repeated below.)
//
// The banner is the panel's only channel to a person who is already connected:
// it is where "you have 2 GiB left" and the support link live. Wrong numbers
// there are worse than none - a customer acts on them.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import {
  formatBytes,
  invalidateSubscriptionSettingsCache,
  renderAnnounce,
} from './settings.service.js';

describe('formatBytes', () => {
  const GiB = 1024n ** 3n;

  it('names the unit the number is actually in', () => {
    expect(formatBytes(0n)).toBe('0 B');
    expect(formatBytes(512n)).toBe('512 B');
    expect(formatBytes(1024n)).toBe('1.0 KiB');
    expect(formatBytes(1024n * 1024n)).toBe('1.0 MiB');
    expect(formatBytes(GiB)).toBe('1.0 GiB');
    expect(formatBytes(1024n * GiB)).toBe('1.0 TiB');
    // The ladder stops at TiB, so anything larger is reported in TiB rather
    // than rolling off the end of the units array into `undefined`.
    expect(formatBytes(1500n * 1024n * GiB)).toBe('1500 TiB');
  });

  // One decimal below ten, none above: "9.8 GiB" is a figure a customer can
  // act on, "9.77 GiB" is noise and "10.4 GiB" is false precision.
  it('keeps one decimal only where it carries information', () => {
    expect(formatBytes(GiB + GiB / 2n)).toBe('1.5 GiB');
    expect(formatBytes(15n * GiB)).toBe('15 GiB');
    // Bytes are whole things; a fractional byte is never right.
    expect(formatBytes(999n)).toBe('999 B');
  });

  // Unlimited and empty are the two ends a subscriber reads most often, and
  // they must not be confusable. `null` is "no limit"; a negative left-over
  // (used more than the limit, which happens between a limit change and the
  // next poll) is nothing left, not a negative amount.
  it('separates unlimited from empty', () => {
    expect(formatBytes(null)).toBe('∞');
    expect(formatBytes(-1n)).toBe('0');
    expect(formatBytes(0n)).toBe('0 B');
  });
});

describe('renderAnnounce', () => {
  const vars = { trafficLeft: '2.0 GiB', daysLeft: '5', supportUrl: 'https://help.example.com' };

  it('substitutes every placeholder, everywhere it appears', () => {
    expect(
      renderAnnounce('{{TRAFFIC_LEFT}} left, {{DAYS_LEFT}} days. Help: {{SUPPORT_URL}}', vars),
    ).toBe('2.0 GiB left, 5 days. Help: https://help.example.com');
    // replaceAll, not replace: a template naming a placeholder twice is an
    // ordinary thing to write, and half-substituting it shows the customer raw
    // template syntax.
    expect(renderAnnounce('{{DAYS_LEFT}}/{{DAYS_LEFT}}', vars)).toBe('5/5');
  });

  it('renders an empty banner for an empty template', () => {
    // The route skips the header entirely on an empty string, so this is how
    // "the operator wrote no banner" reaches the subscriber.
    expect(renderAnnounce(null, vars)).toBe('');
    expect(renderAnnounce('', vars)).toBe('');
  });

  it('leaves text that is not a placeholder alone', () => {
    expect(renderAnnounce('nothing to substitute', vars)).toBe('nothing to substitute');
    expect(renderAnnounce('{{UNKNOWN}}', vars)).toBe('{{UNKNOWN}}');
  });
});

describe('the banner reaches the subscriber', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    await cleanDatabase();
    invalidateSubscriptionSettingsCache();
    token = await registerAndLogin(app);
  });

  afterEach(async () => {
    await app.close();
    invalidateSubscriptionSettingsCache();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis();
  });

  // Checking the two functions in isolation would pass with the header never
  // emitted at all, so this one opens the response the client opens: the
  // `Announce` header, base64-decoded, with the numbers substituted into it.
  it('emits an Announce header with the traffic and days filled in', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: auth,
      payload: {
        subscriptionAnnounceTemplate: 'Осталось {{TRAFFIC_LEFT}} и {{DAYS_LEFT}} дн. {{SUPPORT_URL}}',
        subscriptionSupportUrl: 'https://help.example.com',
      },
    });
    expect(put.statusCode, put.body).toBeLessThan(300);

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth,
      payload: {
        username: 'announce_user',
        trafficLimitBytes: 4 * 1024 ** 3,
        expireAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const user = JSON.parse(created.body);

    const sub = await app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}?format=plain` });
    expect(sub.statusCode).toBe(200);

    const header = sub.headers.announce as string | undefined;
    expect(header, 'the client never sees the banner if the header is not emitted').toBeDefined();
    // `base64:` prefix is the form Happ and Hiddify both accept; the value
    // inside is what the customer actually reads.
    expect(header!.startsWith('base64:')).toBe(true);
    const text = Buffer.from(header!.slice('base64:'.length), 'base64').toString('utf8');

    expect(text).toBe('Осталось 4.0 GiB и 5 дн. https://help.example.com');
  });

  // No template is not an empty banner: the header must be absent, or clients
  // render an empty notice bar to every subscriber on every poll.
  it('emits no Announce header when the operator wrote no banner', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth,
      payload: { username: 'quiet_user' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const user = JSON.parse(created.body);

    const sub = await app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}?format=plain` });
    expect(sub.statusCode).toBe(200);
    expect(sub.headers.announce).toBeUndefined();
  });
});
