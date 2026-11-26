import { describe, expect, it } from 'vitest';
import { servedPortHopping } from './subscription.service.js';

// A range the node does not catch is a promise that silently breaks the
// channel: the client rotates onto ports that reach nothing and nobody logs it.
// So the subscription tells a client about hopping only when the node reported
// a range that covers the whole of the profile's.
describe('servedPortHopping', () => {
  const profile = { start: 20000, end: 50000 };

  it('serves the range when the node reports covering it', () => {
    expect(servedPortHopping(profile, { start: 20000, end: 50000 })).toEqual(profile);
    // A node redirecting more than asked still covers it.
    expect(servedPortHopping({ start: 30000, end: 40000 }, { start: 20000, end: 50000 })).toEqual({ start: 30000, end: 40000 });
  });

  it('serves nothing when the node reported no range (an older agent, an unreadable table)', () => {
    expect(servedPortHopping(profile, undefined)).toEqual({});
    expect(servedPortHopping(profile, null)).toEqual({});
  });

  it('serves nothing when the node reported that it redirects none', () => {
    expect(servedPortHopping(profile, { start: 0, end: 0 })).toEqual({});
  });

  it('serves nothing when the node catches only part of the range', () => {
    expect(servedPortHopping(profile, { start: 20000, end: 30000 })).toEqual({});
    expect(servedPortHopping({ start: 10000, end: 50000 }, { start: 20000, end: 50000 })).toEqual({});
  });

  it('stays out of the way when the profile asks for no hopping', () => {
    expect(servedPortHopping({}, { start: 20000, end: 50000 })).toEqual({});
    expect(servedPortHopping({ start: 20000 }, { start: 20000, end: 50000 })).toEqual({});
  });
});
