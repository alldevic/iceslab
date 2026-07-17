import { describe, expect, it } from 'vitest';
import { CascadeHopSchema, UpdateCascadeSchema } from './cascade.schemas.js';

const UUID = '11111111-2222-4333-8444-555555555555'; // valid v4 (version 4, variant 8)

describe('CascadeHopSchema linkProtocol vocabulary', () => {
  it("accepts 'vless' as a linkProtocol (the historical default link cell)", () => {
    // Regression: linkProtocol was validated with the entry-protocol enum, which
    // omits 'vless', so editing any cascade whose hop stored 'vless' (the seed +
    // every legacy chain) 400'd - even when only the geo split was being changed.
    expect(CascadeHopSchema.safeParse({ nodeId: UUID, position: 0, linkProtocol: 'vless' }).success).toBe(
      true,
    );
    expect(
      CascadeHopSchema.safeParse({ nodeId: UUID, position: 0, linkProtocol: 'shadowsocks' }).success,
    ).toBe(true);
  });

  it("still rejects 'vless' as an ENTRY protocol (not a valid entry core)", () => {
    expect(
      CascadeHopSchema.safeParse({ nodeId: UUID, position: 0, entryProtocol: 'vless' }).success,
    ).toBe(false);
  });

  it('updating a cascade with a vless link hop + a geo split validates', () => {
    const res = UpdateCascadeSchema.safeParse({
      name: 'geo-chain',
      hops: [
        { nodeId: UUID, position: 0, entryProtocol: 'xray', linkProtocol: 'vless' },
        { nodeId: UUID, position: 1 },
      ],
      egressPolicy: [{ geosite: ['category-ru'], target: 'direct' }],
    });
    expect(res.success).toBe(true);
  });
});
