import { describe, expect, it } from 'vitest';
import { pickSpare, rankSpares, scoreSpare } from './pool.policy.js';
import type { BurnedNode, SpareNode } from './pool.types.js';

const burned: BurnedNode = {
  id: 'burned',
  asn: 'AS100',
  provider: 'hetzner',
  countryCode: 'DE',
};

function spare(over: Partial<SpareNode>): SpareNode {
  return {
    id: over.id ?? 's',
    name: over.name ?? over.id ?? 's',
    asn: over.asn ?? null,
    provider: over.provider ?? null,
    countryCode: over.countryCode ?? null,
    consumptionMultiplier: over.consumptionMultiplier ?? 1,
    load: over.load,
  };
}

describe('scoreSpare (F2)', () => {
  it('heavily penalises a spare on the same AS as the burned node', () => {
    const sameAs = spare({ id: 'a', asn: 'AS100' });
    const diffAs = spare({ id: 'b', asn: 'AS200' });
    expect(scoreSpare(diffAs, burned)).toBeGreaterThan(scoreSpare(sameAs, burned));
  });

  it('penalises same provider less than same AS', () => {
    const sameAs = spare({ id: 'a', asn: 'AS100', provider: 'ovh' });
    const sameProvider = spare({ id: 'b', asn: 'AS200', provider: 'hetzner' });
    const clean = spare({ id: 'c', asn: 'AS200', provider: 'ovh' });
    expect(scoreSpare(clean, burned)).toBeGreaterThan(scoreSpare(sameProvider, burned));
    expect(scoreSpare(sameProvider, burned)).toBeGreaterThan(scoreSpare(sameAs, burned));
  });

  it('gives a bonus for same country (geo continuity)', () => {
    const sameCountry = spare({ id: 'a', asn: 'AS200', countryCode: 'DE' });
    const otherCountry = spare({ id: 'b', asn: 'AS200', countryCode: 'FR' });
    expect(scoreSpare(sameCountry, burned)).toBeGreaterThan(scoreSpare(otherCountry, burned));
  });

  it('prefers cheaper (lower consumptionMultiplier) and lighter load', () => {
    const cheap = spare({ id: 'a', asn: 'AS200', consumptionMultiplier: 1 });
    const pricey = spare({ id: 'b', asn: 'AS200', consumptionMultiplier: 5 });
    expect(scoreSpare(cheap, burned)).toBeGreaterThan(scoreSpare(pricey, burned));

    const light = spare({ id: 'a', asn: 'AS200', load: 1 });
    const heavy = spare({ id: 'b', asn: 'AS200', load: 50 });
    expect(scoreSpare(light, burned)).toBeGreaterThan(scoreSpare(heavy, burned));
  });
});

describe('pickSpare (F2)', () => {
  it('returns null for an empty cold pool', () => {
    expect(pickSpare([], burned)).toBeNull();
  });

  it('prefers a diverse spare over one sharing the burned AS', () => {
    const pool = [
      spare({ id: 'same', asn: 'AS100', consumptionMultiplier: 1 }),
      spare({ id: 'diverse', asn: 'AS999', consumptionMultiplier: 3 }),
    ];
    expect(pickSpare(pool, burned)?.id).toBe('diverse');
  });

  it('breaks ties deterministically by id', () => {
    const pool = [
      spare({ id: 'zeta', asn: 'AS200' }),
      spare({ id: 'alpha', asn: 'AS200' }),
    ];
    expect(pickSpare(pool, burned)?.id).toBe('alpha');
    // order-independent
    expect(pickSpare([...pool].reverse(), burned)?.id).toBe('alpha');
  });

  it('rankSpares lists best-first', () => {
    const pool = [
      spare({ id: 'sameAs', asn: 'AS100' }),
      spare({ id: 'best', asn: 'AS200', countryCode: 'DE', consumptionMultiplier: 1 }),
      spare({ id: 'mid', asn: 'AS300', consumptionMultiplier: 4 }),
    ];
    const ranked = rankSpares(pool, burned).map((s) => s.id);
    expect(ranked[0]).toBe('best');
    expect(ranked[ranked.length - 1]).toBe('sameAs');
  });
});
