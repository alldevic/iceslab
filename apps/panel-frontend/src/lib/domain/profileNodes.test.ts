import { describe, expect, it } from 'vitest';
import { nodesByProfile } from '@/lib/domain/profileNodes';

describe('nodesByProfile (A-259): привязки не ноды', () => {
  it('профиль на одной ноде на двух портах это одна нода', () => {
    const m = nodesByProfile([
      { profileId: 'p1', nodeId: 'n1' },
      { profileId: 'p1', nodeId: 'n1' },
      { profileId: 'p1', nodeId: 'n2' },
      { profileId: 'p2', nodeId: 'n1' },
    ]);
    expect(m.get('p1')).toBe(2);
    expect(m.get('p2')).toBe(1);
    expect(m.has('p3')).toBe(false);
  });
});
