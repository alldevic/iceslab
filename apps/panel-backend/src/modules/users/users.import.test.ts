import { describe, expect, it } from 'vitest';
import { CreateUserSchema } from './users.schemas.js';

// The import fields exist so a migration can state a user's EXISTING values
// rather than derive fresh ones. Two things must hold, and they pull in
// opposite directions: an import has to be able to pin every value, while a
// human creating a user by hand must see no change at all.
describe('CreateUserSchema import fields', () => {
  const base = { username: 'alice' };

  it('leaves a hand-made create untouched: no import fields, no defaults invented', () => {
    const parsed = CreateUserSchema.parse(base);
    expect(parsed.expireAt).toBeUndefined();
    expect(parsed.vlessUuid).toBeUndefined();
    expect(parsed.createdAt).toBeUndefined();
    expect(parsed.sourceId).toBeUndefined();
  });

  it('accepts an absolute expiry, a carried identity, a registration date and provenance', () => {
    const parsed = CreateUserSchema.parse({
      ...base,
      expireAt: '2027-01-31T00:00:00.000Z',
      vlessUuid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      createdAt: '2023-06-01T12:00:00.000Z',
      sourceId: 'legacy-user-4711',
    });
    expect(parsed.expireAt).toBe('2027-01-31T00:00:00.000Z');
    expect(parsed.vlessUuid).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(parsed.createdAt).toBe('2023-06-01T12:00:00.000Z');
    expect(parsed.sourceId).toBe('legacy-user-4711');
  });

  // A malformed identity must be refused at the edge. Letting it through would
  // hand the user a config that cannot authenticate, and the failure would only
  // surface on their device, far from the import that caused it.
  it('refuses a vlessUuid that is not a uuid', () => {
    expect(() => CreateUserSchema.parse({ ...base, vlessUuid: 'not-a-uuid' })).toThrow();
  });

  it('refuses a non-ISO expireAt rather than guessing a date', () => {
    expect(() => CreateUserSchema.parse({ ...base, expireAt: '31.01.2027' })).toThrow();
  });

  // Both may arrive together (an importer filling every field it has); the
  // service resolves the conflict by preferring the absolute instant, since
  // that is the fact being transferred.
  it('accepts expireAt and expireDays together, leaving precedence to the service', () => {
    const parsed = CreateUserSchema.parse({
      ...base,
      expireAt: '2027-01-31T00:00:00.000Z',
      expireDays: 30,
    });
    expect(parsed.expireAt).toBe('2027-01-31T00:00:00.000Z');
    expect(parsed.expireDays).toBe(30);
  });
});
