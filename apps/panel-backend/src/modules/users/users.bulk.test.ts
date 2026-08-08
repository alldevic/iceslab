import { describe, expect, it } from 'vitest';
import { BulkUsersSchema, MAX_BULK_USERS } from './users.schemas.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('BulkUsersSchema', () => {
  it('accepts an action over several users', () => {
    const parsed = BulkUsersSchema.parse({ userIds: [ID(1), ID(2)], action: 'revoke' });
    expect(parsed.userIds).toHaveLength(2);
    expect(parsed.action).toBe('revoke');
  });

  // extend without a span is the one combination that cannot be given a sane
  // default: guessing a month would silently hand out free time.
  it('refuses extend without expireDays', () => {
    expect(() => BulkUsersSchema.parse({ userIds: [ID(1)], action: 'extend' })).toThrow();
  });

  it('accepts extend when the span is given', () => {
    const parsed = BulkUsersSchema.parse({
      userIds: [ID(1)],
      action: 'extend',
      expireDays: 30,
    });
    expect(parsed.expireDays).toBe(30);
  });

  // The cap bounds the blast radius of one mistaken call, not the throughput:
  // a bigger job is expected to page.
  it('refuses a batch over the cap', () => {
    const tooMany = Array.from({ length: MAX_BULK_USERS + 1 }, (_, i) => ID(i));
    expect(() => BulkUsersSchema.parse({ userIds: tooMany, action: 'delete' })).toThrow();
  });

  it('refuses an empty batch rather than reporting a no-op as success', () => {
    expect(() => BulkUsersSchema.parse({ userIds: [], action: 'delete' })).toThrow();
  });

  it('refuses an unknown action instead of ignoring it', () => {
    expect(() =>
      BulkUsersSchema.parse({ userIds: [ID(1)], action: 'terminate-with-prejudice' }),
    ).toThrow();
  });
});
