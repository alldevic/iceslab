import { describe, expect, it } from 'vitest';
import { servedPortHopping } from './subscription.service.js';

// Measured on the deployment 2026-09-03. The profile was given 20000-50000,
// the node redirected nothing (`iptables -t nat` empty, the range closed in
// ufw), and every Hysteria client answered `timeout: no recent network
// activity` while TCP through the same cascade returned the exit address. The
// same config with the range removed connected on the first try.
//
// So the rule under test is not a preference: a range the node does not catch
// is a promise that silently breaks the channel, and the panel had no way to
// notice - `assertPortHoppingFitsNodes` passes when the node reported nothing,
// which is exactly the case that cannot work.
describe('servedPortHopping', () => {
  it('serves the range when the node reports covering it', () => {
    expect(servedPortHopping({ start: 20000, end: 50000 }, { start: 20000, end: 50000 })).toEqual({
      start: 20000,
      end: 50000,
    });
    // A node redirecting MORE than asked still covers it.
    expect(servedPortHopping({ start: 30000, end: 40000 }, { start: 20000, end: 50000 })).toEqual({
      start: 30000,
      end: 40000,
    });
  });

  it('serves nothing when the node reported no range at all', () => {
    // The case that broke production: not "any range", but no answer. An
    // unverified number must not reach a client as a fact.
    expect(servedPortHopping({ start: 20000, end: 50000 }, { start: null, end: null })).toEqual({});
    expect(servedPortHopping({ start: 20000, end: 50000 }, {})).toEqual({});
  });

  it('serves nothing when the node catches only part of the range', () => {
    // Half-served is the worst of the three: some connections land, some do
    // not, and the buyer reports an intermittent fault rather than a dead one.
    expect(servedPortHopping({ start: 20000, end: 50000 }, { start: 20000, end: 30000 })).toEqual({});
    expect(servedPortHopping({ start: 10000, end: 50000 }, { start: 20000, end: 50000 })).toEqual({});
  });

  it('stays out of the way when the profile asks for no hopping', () => {
    expect(servedPortHopping({}, { start: 20000, end: 50000 })).toEqual({});
    expect(servedPortHopping({ start: 20000 }, { start: 20000, end: 50000 })).toEqual({});
  });
});
